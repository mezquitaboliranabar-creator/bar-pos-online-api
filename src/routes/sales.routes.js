const express = require("express");
const { authMiddleware } = require("./auth.routes");
const Sale = require("../models/Sale");
const SaleItem = require("../models/SaleItem");
const Payment = require("../models/Payment");
const SaleReturn = require("../models/SaleReturn");
const Product = require("../models/Product");
const InventoryMove = require("../models/InventoryMove");
const ProductRecipe = require("../models/ProductRecipe");

// Crea el router para agrupar las rutas de ventas
const router = express.Router();

// Redondea un valor numérico a entero
function roundInt(v) {
  return Math.round(Number(v || 0));
}

// Calcula totales de línea para un item de venta
function calcLineTotals(unit_price, qty, line_discount, tax_rate) {
  const gross = unit_price * qty;
  const discount = Math.max(0, Number(line_discount || 0));
  const base = Math.max(0, gross - discount);
  const rate = typeof tax_rate === "number" ? tax_rate : null;
  const tax = rate !== null ? roundInt((base * rate) / 100) : 0;
  const total = base + tax;
  return { gross, discount, base, tax, total };
}

// Normaliza un rango de fechas para inicio o fin de día
function normalizeRangeDate(value, isStart) {
  if (!value) return null;
  const s = String(value);
  if (s.length === 10) {
    return isStart ? s + " 00:00:00" : s + " 23:59:59";
  }
  return s;
}

// Obtiene el resumen de pagos agrupado por método y proveedor
async function aggregatePaymentsSummary(filter) {
  const pipeline = [
    { $match: filter },
    {
      $group: {
        _id: { method: "$method", provider: "$provider" },
        total: { $sum: "$amount" },
      },
    },
    {
      $project: {
        _id: 0,
        method: "$_id.method",
        provider: "$_id.provider",
        total: 1,
      },
    },
    { $sort: { method: 1, provider: 1 } },
  ];
  const rows = await Payment.aggregate(pipeline);
  return rows;
}

// Mapea el tipo de producto al tipo de inventario
function mapKindToInvType(kind) {
  const k = String(kind || "").toUpperCase();
  if (k === "BASE") return "BASE";
  if (k === "ACCOMP") return "ACCOMP";
  return "UNIT";
}

// Define la categoría de medida para unidades de inventario
function measureCategory(measure) {
  const m = String(measure || "").toUpperCase();
  if (m === "ML") return "VOLUME";
  if (m === "G") return "MASS";
  if (m === "UNIT") return "UNIT";
  return null;
}

// Define tablas de conversión para volumen y masa
const VOL_TO_ML = { ML: 1, L: 1000, CL: 10, OZ: 29.57, SHOT: 44 };
const MASS_TO_G = { G: 1, KG: 1000, LB: 453.592 };

// Convierte una cantidad del producto a su unidad canónica de inventario
function toCanonicalQty(prod, qty, unit) {
  const q = Number(qty || 0);
  if (!(q > 0)) return { ok: false, error: "Cantidad inválida" };

  const invType = mapKindToInvType(prod.kind);
  let canon = null;

  if (invType === "BASE") canon = "ML";
  if (!canon) canon = invType === "ACCOMP" ? "UNIT" : "UNIT";

  const cat = measureCategory(canon);
  const u = String(unit || canon).toUpperCase();

  if (cat === "UNIT") {
    if (u !== "UNIT") return { ok: false, error: "Unidad incompatible: UNIT" };
    if (!Number.isFinite(q) || Math.round(q) !== q) {
      return { ok: false, error: "UNIT requiere enteros" };
    }
    return { ok: true, qty: q, canon };
  }

  if (cat === "VOLUME") {
    const f = VOL_TO_ML[u];
    if (!f) return { ok: false, error: `Unidad volumen inválida: ${u}` };
    return { ok: true, qty: Math.ceil(q * f), canon };
  }

  if (cat === "MASS") {
    const f = MASS_TO_G[u];
    if (!f) return { ok: false, error: `Unidad masa inválida: ${u}` };
    return { ok: true, qty: Math.ceil(q * f), canon };
  }

  return { ok: false, error: "Medida no soportada" };
}

// Convierte cantidad de receta a unidad canónica del ingrediente
function recipeQtyToCanonical(ingProd, role, recipeQty, recipeUnit) {
  const r = String(role || "").toUpperCase();
  const invType = mapKindToInvType(ingProd.kind);
  const canon =
    invType === "BASE"
      ? "ML"
      : String(ingProd.measure || "").toUpperCase() || "UNIT";
  const cat = measureCategory(canon);

  if (r === "BASE") {
    const u = String(recipeUnit || "ML").toUpperCase();
    const f = VOL_TO_ML[u];
    if (!f) {
      return {
        ok: false,
        error: `Unidad volumen inválida en receta: ${u}`,
      };
    }
    return {
      ok: true,
      qty: Math.ceil(Number(recipeQty || 0) * f),
      canon,
    };
  }

  if (cat === "UNIT") {
    if (String(recipeUnit || "UNIT").toUpperCase() !== "UNIT") {
      return {
        ok: false,
        error: `Acompañamiento ${ingProd.name} usa UNIT`,
      };
    }
    const q = Number(recipeQty || 0);
    if (!(q > 0) || Math.round(q) !== q) {
      return { ok: false, error: "ACCOMP UNIT requiere enteros" };
    }
    return { ok: true, qty: q, canon };
  }

  if (cat === "VOLUME") {
    const u = String(recipeUnit || "ML").toUpperCase();
    const f = VOL_TO_ML[u];
    if (!f) {
      return {
        ok: false,
        error: `Unidad volumen inválida en receta: ${u}`,
      };
    }
    return {
      ok: true,
      qty: Math.ceil(Number(recipeQty || 0) * f),
      canon,
    };
  }

  if (cat === "MASS") {
    const u = String(recipeUnit || "G").toUpperCase();
    const f = MASS_TO_G[u];
    if (!f) {
      return {
        ok: false,
        error: `Unidad masa inválida en receta: ${u}`,
      };
    }
    return {
      ok: true,
      qty: Math.ceil(Number(recipeQty || 0) * f),
      canon,
    };
  }

  return { ok: false, error: "Canónica no soportada" };
}

// Suma lo ya devuelto por sale_item considerando nuevo y legacy
function sumReturnedQtyForItem(returnsDocs, saleItemId) {
  const key = String(saleItemId);
  let sum = 0;

  for (const r of returnsDocs || []) {
    if (Array.isArray(r.items) && r.items.length > 0) {
      for (const it of r.items) {
        if (String(it.sale_item_id || "") === key) {
          sum += Number(it.qty || 0);
        }
      }
    } else if (r.sale_item && String(r.sale_item) === key) {
      sum += Number(r.qty || 0);
    }
  }

  return Math.max(0, sum);
}

// ============================
// LISTADO / CATÁLOGO / REPORT
// ============================

// Lista las ventas con filtros por fecha, estado y usuario
router.get("/", authMiddleware, async (req, res) => {
  try {
    const {
      start,
      end,
      status,
      user_id,
      limit = "100",
      offset = "0",
    } = req.query;

    const filter = {};
    const and = [];

    const startNorm = normalizeRangeDate(start, true);
    const endNorm = normalizeRangeDate(end, false);

    if (startNorm || endNorm) {
      const range = {};
      if (startNorm) range.$gte = new Date(startNorm);
      if (endNorm) range.$lte = new Date(endNorm);
      and.push({ createdAt: range });
    }

    if (status) {
      and.push({ status: String(status).toUpperCase() });
    }

    if (user_id) {
      and.push({ user: user_id });
    }

    if (and.length > 0) {
      filter.$and = and;
    }

    const lim = Math.max(1, Math.min(500, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);

    const sales = await Sale.find(filter)
      .populate("user", "username name role")
      .sort({ createdAt: -1, _id: -1 })
      .skip(off)
      .limit(lim);

    const items = sales.map((s) => s.toJSON());

    return res.json({
      ok: true,
      items,
      total: items.length,
    });
  } catch (error) {
    console.error("Error al listar ventas:", error.message);
    return res.status(500).json({ ok: false, error: "Error al listar ventas" });
  }
});

// Obtiene el catálogo de productos para la venta
router.get("/catalog", authMiddleware, async (req, res) => {
  try {
    const { q = "", limit = "500", offset = "0" } = req.query;

    const text = String(q || "").trim().toLowerCase();

    const filter = {
      is_active: true,
      kind: { $in: ["STANDARD", "COCKTAIL"] },
    };

    if (text) {
      const regex = new RegExp(text, "i");
      filter.$or = [{ name: regex }, { category: regex }];
    }

    const lim = Math.max(1, Math.min(1000, Number(limit) || 500));
    const off = Math.max(0, Number(offset) || 0);

    const products = await Product.find(filter)
      .sort({ name: 1 })
      .skip(off)
      .limit(lim);

    const items = products.map((p) => {
      const obj = p.toJSON();
      const stock_available = Math.max(0, Number(obj.stock || 0));
      return {
        id: obj.id,
        name: obj.name,
        category: obj.category,
        price: obj.price,
        stock: obj.stock,
        min_stock: obj.min_stock,
        is_active: obj.is_active,
        kind: obj.kind,
        inv_type: obj.inv_type,
        measure: obj.measure,
        stock_available,
      };
    });

    return res.json({
      ok: true,
      items,
      total: items.length,
    });
  } catch (error) {
    console.error("Error al obtener catálogo de ventas:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener catálogo de ventas" });
  }
});

// Obtiene el resumen de pagos por método y proveedor
router.get("/payments/summary", authMiddleware, async (req, res) => {
  try {
    const { start, end } = req.query;

    const filter = {};
    const and = [];

    const startNorm = normalizeRangeDate(start, true);
    const endNorm = normalizeRangeDate(end, false);

    if (startNorm || endNorm) {
      const range = {};
      if (startNorm) range.$gte = new Date(startNorm);
      if (endNorm) range.$lte = new Date(endNorm);
      and.push({ createdAt: range });
    }

    if (and.length > 0) {
      filter.$and = and;
    }

    const items = await aggregatePaymentsSummary(filter);

    return res.json({
      ok: true,
      items,
    });
  } catch (error) {
    console.error("Error al obtener resumen de pagos:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener resumen de pagos" });
  }
});

// Obtiene un resumen de ventas con totales y ganancia
router.get("/report", authMiddleware, async (req, res) => {
  try {
    const { start, end, status, user_id } = req.query;

    const filter = {};
    const and = [];

    const startNorm = normalizeRangeDate(start, true);
    const endNorm = normalizeRangeDate(end, false);

    if (startNorm || endNorm) {
      const range = {};
      if (startNorm) range.$gte = new Date(startNorm);
      if (endNorm) range.$lte = new Date(endNorm);
      and.push({ createdAt: range });
    }

    if (status) {
      and.push({ status: String(status).toUpperCase() });
    }

    if (user_id) {
      and.push({ user: user_id });
    }

    if (and.length > 0) {
      filter.$and = and;
    }

    const sales = await Sale.find(filter);

    const count = sales.length;
    let sumSubtotal = 0;
    let sumDiscount = 0;
    let sumTax = 0;
    let sumTotal = 0;

    for (const s of sales) {
      sumSubtotal += Number(s.subtotal || 0);
      sumDiscount += Number(s.discount_total || 0);
      sumTax += Number(s.tax_total || 0);
      sumTotal += Number(s.total || 0);
    }

    const profit = sumTotal;

    return res.json({
      ok: true,
      summary: {
        count,
        subtotal: sumSubtotal,
        discount_total: sumDiscount,
        tax_total: sumTax,
        total: sumTotal,
        profit,
      },
    });
  } catch (error) {
    console.error("Error al obtener reporte de ventas:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener reporte de ventas" });
  }
});

// ============================
// DETALLE
// ============================

// Obtiene el detalle de una venta con ítems, pagos y devoluciones
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const sale = await Sale.findById(id).populate("user", "username name role");

    if (!sale) {
      return res.status(404).json({ ok: false, error: "Venta no encontrada" });
    }

    const [items, payments, returns] = await Promise.all([
      SaleItem.find({ sale: sale._id }).populate("product"),
      Payment.find({ sale: sale._id }),
      SaleReturn.find({ sale: sale._id }),
    ]);

    return res.json({
      ok: true,
      sale: sale.toJSON(),
      items: items.map((i) => i.toJSON()),
      payments: payments.map((p) => p.toJSON()),
      returns: returns.map((r) => r.toJSON()),
    });
  } catch (error) {
    console.error("Error al obtener venta:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener venta" });
  }
});

// ============================
// CREAR VENTA
// ============================

// Crea una nueva venta con ítems, pagos y movimientos de inventario simples
router.post("/", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    const { items, payments, notes, client, location } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Items requeridos" });
    }

    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ ok: false, error: "Pagos requeridos" });
    }

    const normalizedPayments = [];
    let paid = 0;

    for (const p of payments) {
      const method = String(p.method || "").toUpperCase();
      if (!["CASH", "CARD", "TRANSFER", "OTHER"].includes(method)) {
        return res.status(400).json({ ok: false, error: "Método de pago inválido" });
      }

      const amount = Number(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ ok: false, error: "Monto de pago inválido" });
      }

      let provider = null;
      if (method === "TRANSFER") {
        const prov = String(p.provider || "").toUpperCase();
        if (!["NEQUI", "DAVIPLATA"].includes(prov)) {
          return res.status(400).json({ ok: false, error: "Proveedor de transferencia inválido" });
        }
        provider = prov;
      }

      const reference = p.reference ? String(p.reference) : null;

      normalizedPayments.push({ method, provider, amount, reference });
      paid += amount;
    }

    const productIds = items.map((it) => it.productId || it.product_id);
    const uniqueIds = [...new Set(productIds.filter(Boolean))];

    const products = await Product.find({ _id: { $in: uniqueIds } });
    const productMap = new Map(products.map((p) => [p.id.toString(), p]));

    let subtotal = 0;
    let discount_total = 0;
    let tax_total = 0;
    let total = 0;

    const itemRows = [];

    for (const it of items) {
      const rawId = it.productId || it.product_id;
      const qty = Number(it.qty);

      if (!rawId) {
        return res.status(400).json({ ok: false, error: "Producto inválido en item" });
      }

      if (!Number.isFinite(qty) || qty <= 0 || Math.round(qty) !== qty) {
        return res.status(400).json({ ok: false, error: "Cantidad inválida en item" });
      }

      const prod = productMap.get(String(rawId));
      if (!prod) {
        return res.status(404).json({ ok: false, error: "Producto no encontrado" });
      }

      const unit_price =
        it.unit_price !== undefined && it.unit_price !== null
          ? Number(it.unit_price)
          : Number(prod.price || 0);

      if (!Number.isFinite(unit_price) || unit_price < 0) {
        return res.status(400).json({ ok: false, error: "Precio inválido en item" });
      }

      const line_discount =
        it.line_discount !== undefined && it.line_discount !== null
          ? Number(it.line_discount)
          : 0;

      let tax_rate = null;
      if (it.tax_rate !== undefined && it.tax_rate !== null) {
        const tr = Number(it.tax_rate);
        if (!Number.isNaN(tr)) {
          tax_rate = tr;
        }
      }

      const { gross, discount, base, tax, total: line_total } = calcLineTotals(
        unit_price,
        qty,
        line_discount,
        tax_rate
      );

      const available = Number(prod.stock || 0);
      if (available < qty) {
        return res.status(400).json({
          ok: false,
          error: "Stock insuficiente",
          product_id: prod.id,
          requested: qty,
          available,
        });
      }

      itemRows.push({
        product: prod,
        qty,
        unit_price,
        line_discount: discount,
        tax_rate,
        tax_amount: tax,
        line_total,
      });

      subtotal += gross - discount;
      discount_total += discount;
      tax_total += tax;
      total += line_total;
    }

    if (paid < total) {
      return res.status(400).json({ ok: false, error: "Pagos insuficientes" });
    }

    const sale = await Sale.create({
      user: user.id,
      status: "COMPLETED",
      subtotal,
      discount_total,
      tax_total,
      total,
      notes: notes || null,
      client: client || null,
    });

    for (const r of itemRows) {
      await SaleItem.create({
        sale: sale._id,
        product: r.product._id,
        qty: r.qty,
        unit_price: r.unit_price,
        line_discount: r.line_discount,
        tax_rate: r.tax_rate,
        tax_amount: r.tax_amount,
        line_total: r.line_total,
        name_snapshot: r.product.name,
        category_snapshot: r.product.category || null,
      });

      const prod = r.product;
      const newStock = Number(prod.stock || 0) - r.qty;
      if (newStock < 0) {
        throw new Error("Stock negativo al aplicar venta");
      }

      prod.stock = newStock;
      await prod.save();

      await InventoryMove.create({
        product: prod._id,
        qty: -r.qty,
        note: "Venta " + sale.id,
        user: user.id,
        type: "OUT",
        sourceRef: sale.id.toString(),
        location: location || null,
        supplierId: null,
        supplierName: null,
        invoiceNumber: null,
        unitCost: null,
        discount: null,
        tax: null,
        lot: null,
        expiryDate: null,
      });
    }

    const cashIndexes = normalizedPayments
      .map((p, i) => ({ i, p }))
      .filter((x) => x.p.method === "CASH")
      .map((x) => x.i);

    const overpay = paid - total;
    let change = 0;
    if (overpay > 0 && cashIndexes.length > 0) {
      change = overpay;
    }

    const paymentsDocs = [];

    normalizedPayments.forEach((p, idx) => {
      const isLastCash =
        cashIndexes.length > 0 && idx === cashIndexes[cashIndexes.length - 1];
      const change_given = isLastCash ? change : 0;

      paymentsDocs.push(
        new Payment({
          sale: sale._id,
          method: p.method,
          provider: p.provider || null,
          amount: p.amount,
          change_given,
          reference: p.reference || null,
        })
      );
    });

    if (paymentsDocs.length > 0) {
      await Payment.insertMany(paymentsDocs);
    }

    const freshSale = await Sale.findById(sale._id).populate(
      "user",
      "username name role"
    );
    const freshItems = await SaleItem.find({ sale: sale._id }).populate("product");
    const freshPayments = await Payment.find({ sale: sale._id });

    return res.status(201).json({
      ok: true,
      sale: freshSale.toJSON(),
      items: freshItems.map((i) => i.toJSON()),
      payments: freshPayments.map((p) => p.toJSON()),
    });
  } catch (error) {
    console.error("Error al crear venta:", error.message);
    return res.status(500).json({ ok: false, error: "Error al crear venta" });
  }
});

// Crea una nueva venta aplicando recetas para cocteles
router.post("/with-recipes", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    const { items, payments, notes, client, tab_id, location } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Items requeridos" });
    }

    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ ok: false, error: "Pagos requeridos" });
    }

    const normalizedPayments = [];
    let paid = 0;

    for (const p of payments) {
      const method = String(p.method || "").toUpperCase();
      if (!["CASH", "CARD", "TRANSFER", "OTHER"].includes(method)) {
        return res.status(400).json({ ok: false, error: "Método de pago inválido" });
      }

      const amount = Number(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ ok: false, error: "Monto de pago inválido" });
      }

      let provider = null;
      if (method === "TRANSFER") {
        const prov = String(p.provider || "").toUpperCase();
        if (!["NEQUI", "DAVIPLATA"].includes(prov)) {
          return res.status(400).json({ ok: false, error: "Proveedor de transferencia inválido" });
        }
        provider = prov;
      }

      const reference = p.reference ? String(p.reference) : null;

      normalizedPayments.push({ method, provider, amount, reference });
      paid += amount;
    }

    const normalizedItems = items.map((it) => ({
      productId: it.productId || it.product_id,
      qty: Number(it.qty),
      unit_price: it.unit_price,
      line_discount: it.line_discount || 0,
      tax_rate: typeof it.tax_rate === "number" ? it.tax_rate : null,
      note: it.note ? String(it.note).slice(0, 200) : null,
    }));

    const productIds = normalizedItems.map((it) => it.productId).filter(Boolean);
    const uniqueIds = [...new Set(productIds.map((id) => String(id)))];

    if (uniqueIds.length === 0) {
      return res.status(400).json({ ok: false, error: "Productos inválidos en items" });
    }

    const products = await Product.find({ _id: { $in: uniqueIds } });
    const productMap = new Map(products.map((p) => [p.id.toString(), p]));

    const recipeCache = new Map();
    const ingredientCache = new Map();

    async function loadRecipeRowsForProduct(prod) {
      const key = prod.id.toString();
      if (recipeCache.has(key)) return recipeCache.get(key);
      const rows = await ProductRecipe.find({ product: prod._id });
      recipeCache.set(key, rows);
      return rows;
    }

    async function getIngredientProduct(id) {
      const key = String(id);
      if (ingredientCache.has(key)) return ingredientCache.get(key);
      const prod = await Product.findById(key);
      if (prod) ingredientCache.set(key, prod);
      return prod;
    }

    const invPlan = [];
    const itemRowsTmp = [];

    let subtotal = 0;
    let discount_total = 0;
    let tax_total = 0;
    let total = 0;

    for (const it of normalizedItems) {
      const pid = it.productId;
      const qty = it.qty;

      if (!pid) {
        return res.status(400).json({ ok: false, error: "Producto inválido en item" });
      }

      if (!Number.isFinite(qty) || qty <= 0 || Math.round(qty) !== qty) {
        return res.status(400).json({ ok: false, error: "Cantidad inválida en item" });
      }

      const prod = productMap.get(String(pid));
      if (!prod) {
        return res.status(404).json({ ok: false, error: "Producto no encontrado" });
      }

      const price =
        it.unit_price !== undefined && it.unit_price !== null
          ? Number(it.unit_price)
          : Number(prod.price || 0);

      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ ok: false, error: "Precio inválido en item" });
      }

      const { gross, discount, base, tax, total: line_total } = calcLineTotals(
        price,
        qty,
        it.line_discount || 0,
        it.tax_rate
      );

      const kind = String(prod.kind || "STANDARD").toUpperCase();

      if (kind === "BASE" || kind === "ACCOMP") {
        return res.status(400).json({
          ok: false,
          error: `No se puede vender ${prod.name}: es un insumo (${kind})`,
        });
      }

      if (kind === "STANDARD") {
        const available = Number(prod.stock || 0);
        if (available < qty) {
          return res.status(400).json({
            ok: false,
            error: "Stock insuficiente",
            product_id: prod.id,
            requested: qty,
            available,
          });
        }
      } else if (kind === "COCKTAIL") {
        const recipeRows = await loadRecipeRowsForProduct(prod);
        if (!recipeRows.length) {
          return res.status(400).json({
            ok: false,
            error: `El cóctel ${prod.name} no tiene receta`,
          });
        }

        for (const r of recipeRows) {
          const ing = await getIngredientProduct(r.ingredient);
          if (!ing) {
            return res.status(400).json({
              ok: false,
              error: `Ingrediente ${r.ingredient.toString()} no existe`,
            });
          }
          const conv = recipeQtyToCanonical(ing, r.role, r.qty, r.unit);
          if (!conv.ok) {
            return res.status(400).json({ ok: false, error: conv.error });
          }
          const need = Math.ceil(conv.qty * Math.max(1, Math.round(qty)));
          const available = Number(ing.stock || 0);
          if (available < need) {
            return res.status(400).json({
              ok: false,
              error: `Stock insuficiente de ${ing.name}`,
              product_id: ing.id,
              requested: need,
              available,
            });
          }
        }
      }

      async function addToInvPlan() {
        const k = String(prod.kind || "STANDARD").toUpperCase();

        if (k === "STANDARD") {
          const conv = toCanonicalQty(prod, qty, prod.measure || "UNIT");
          if (!conv.ok) {
            return res.status(400).json({ ok: false, error: conv.error });
          }
          invPlan.push({
            productId: prod._id,
            qty: -Math.ceil(conv.qty),
            type: "SALE",
            label: prod.name,
          });
          return;
        }

        if (k === "COCKTAIL") {
          const recipeRows = await loadRecipeRowsForProduct(prod);
          if (!recipeRows.length) {
            return res.status(400).json({
              ok: false,
              error: `El cóctel ${prod.name} no tiene receta`,
            });
          }

          for (const r of recipeRows) {
            const ing = await getIngredientProduct(r.ingredient);
            if (!ing) {
              return res.status(400).json({
                ok: false,
                error: `Ingrediente ${r.ingredient.toString()} no existe`,
              });
            }
            const conv = recipeQtyToCanonical(ing, r.role, r.qty, r.unit);
            if (!conv.ok) {
              return res.status(400).json({ ok: false, error: conv.error });
            }
            const need = Math.ceil(conv.qty * Math.max(1, Math.round(qty)));
            const moveType =
              String(r.role || "BASE").toUpperCase() === "ACCOMP"
                ? "ACCOMP_USE"
                : "RECIPE_USE";

            invPlan.push({
              productId: ing._id,
              qty: -need,
              type: moveType,
              label: ing.name,
            });
          }
          return;
        }

        const conv = toCanonicalQty(prod, qty, prod.measure || "UNIT");
        if (!conv.ok) {
          return res.status(400).json({ ok: false, error: conv.error });
        }
        invPlan.push({
          productId: prod._id,
          qty: -Math.ceil(conv.qty),
          type: "SALE",
          label: prod.name,
        });
      }

      await addToInvPlan();

      subtotal += base;
      discount_total += discount;
      tax_total += tax;
      total += line_total;

      itemRowsTmp.push({
        product: prod,
        qty_units: qty,
        unit_price: price,
        line_discount: discount,
        tax_rate: it.tax_rate,
        tax_amount: tax,
        line_total,
      });
    }

    if (paid < total) {
      return res.status(400).json({ ok: false, error: "Pagos insuficientes" });
    }

    const sale = await Sale.create({
      user: user.id,
      status: "COMPLETED",
      subtotal,
      discount_total,
      tax_total,
      total,
      notes: notes || null,
      client: client || null,
    });

    for (const r of itemRowsTmp) {
      await SaleItem.create({
        sale: sale._id,
        product: r.product._id,
        qty: r.qty_units,
        unit_price: r.unit_price,
        line_discount: r.line_discount,
        tax_rate: r.tax_rate,
        tax_amount: r.tax_amount,
        line_total: r.line_total,
        name_snapshot: r.product.name,
        category_snapshot: r.product.category || null,
      });
    }

    const headerNote = `Venta ${sale.id}`;

    for (const mv of invPlan) {
      const prod = await Product.findById(mv.productId);
      if (!prod) {
        return res.status(400).json({
          ok: false,
          error: "Producto de inventario no encontrado para movimiento",
        });
      }

      const currentStock = Number(prod.stock || 0);
      const nextStock = currentStock + mv.qty;
      if (nextStock < 0) {
        return res.status(400).json({
          ok: false,
          error: `Stock negativo para ${prod.name}`,
        });
      }

      prod.stock = nextStock;
      await prod.save();

      await InventoryMove.create({
        product: prod._id,
        qty: mv.qty,
        note: headerNote,
        type: mv.type,
        sourceRef: sale.id.toString(),
        user: user.id,
        location: location || null,
        supplierId: null,
        supplierName: null,
        invoiceNumber: null,
        unitCost: null,
        discount: null,
        tax: null,
        lot: null,
        expiryDate: null,
      });
    }

    const cashIndexes = normalizedPayments
      .map((p, i) => ({ i, p }))
      .filter((x) => x.p.method === "CASH")
      .map((x) => x.i);

    const overpay = paid - total;
    let change = 0;
    if (overpay > 0 && cashIndexes.length > 0) {
      change = overpay;
    }

    const paymentsDocs = [];

    normalizedPayments.forEach((p, idx) => {
      const isLastCash =
        cashIndexes.length > 0 && idx === cashIndexes[cashIndexes.length - 1];
      const change_given = isLastCash ? change : 0;

      paymentsDocs.push(
        new Payment({
          sale: sale._id,
          method: p.method,
          provider: p.provider || null,
          amount: p.amount,
          change_given,
          reference: p.reference || null,
        })
      );
    });

    if (paymentsDocs.length > 0) {
      await Payment.insertMany(paymentsDocs);
    }

    const freshSale = await Sale.findById(sale._id).populate(
      "user",
      "username name role"
    );
    const freshItems = await SaleItem.find({ sale: sale._id }).populate("product");
    const freshPayments = await Payment.find({ sale: sale._id });

    return res.status(201).json({
      ok: true,
      sale: freshSale.toJSON(),
      items: freshItems.map((i) => i.toJSON()),
      payments: freshPayments.map((p) => p.toJSON()),
    });
  } catch (error) {
    console.error("Error al crear venta con recetas:", error.message);
    return res
      .status(500)
      .json({ ok: false, error: "Error al crear venta con recetas" });
  }
});

// ============================
// DEVOLUCIONES
// ============================

// Registra devolución y devuelve stock sin modificar el estado de la venta
async function handleSaleReturn(req, res, saleIdParam) {
  try {
    const user = req.user;

    const {
      sale_id,
      items,
      sale_item,
      qty,
      refund_amount,
      note,
      record_refund_payment = false,
      location,
    } = req.body || {};

    const saleId = saleIdParam || sale_id;

    if (!saleId) {
      return res.status(400).json({ ok: false, error: "sale_id requerido" });
    }

    // Normaliza payload nuevo y legacy
    let reqItems = [];
    if (Array.isArray(items) && items.length > 0) {
      reqItems = items;
    } else if (sale_item && qty) {
      reqItems = [{ sale_item_id: sale_item, qty, refund_amount }];
    }

    if (!Array.isArray(reqItems) || reqItems.length === 0) {
      return res.status(400).json({ ok: false, error: "Items requeridos para devolución" });
    }

    const sale = await Sale.findById(saleId);
    if (!sale) {
      return res.status(404).json({ ok: false, error: "Venta no encontrada" });
    }

    if (String(sale.status || "").toUpperCase() === "VOIDED") {
      return res.status(400).json({ ok: false, error: "No se puede devolver una venta anulada" });
    }

    const [saleItems, existingReturns] = await Promise.all([
      SaleItem.find({ sale: sale._id }).populate("product"),
      SaleReturn.find({ sale: sale._id }),
    ]);

    if (!saleItems.length) {
      return res.status(400).json({ ok: false, error: "Venta sin items" });
    }

    const saleItemMap = new Map(saleItems.map((si) => [si.id.toString(), si]));

    // Valida items y calcula máximo devolvible
    const normalizedReqItems = [];
    for (const it of reqItems) {
      const saleItemId = it.sale_item_id || it.saleItemId || it.sale_item;
      const q = Number(it.qty);
      const ra = it.refund_amount !== undefined && it.refund_amount !== null ? Number(it.refund_amount) : null;

      if (!saleItemId) {
        return res.status(400).json({ ok: false, error: "sale_item_id requerido en item" });
      }
      if (!Number.isFinite(q) || q <= 0 || Math.round(q) !== q) {
        return res.status(400).json({ ok: false, error: "Cantidad inválida en devolución" });
      }

      const si = saleItemMap.get(String(saleItemId));
      if (!si) {
        return res.status(404).json({ ok: false, error: "SaleItem no encontrado en la venta" });
      }

      const already = sumReturnedQtyForItem(existingReturns, si.id);
      const maxQty = Math.max(0, Number(si.qty || 0) - already);

      if (q > maxQty) {
        return res.status(400).json({
          ok: false,
          error: "Cantidad de devolución supera disponible",
          sale_item_id: si.id,
          requested: q,
          available: maxQty,
        });
      }

      normalizedReqItems.push({ si, qtyReturn: q, refundOverride: ra });
    }

    // Cache de recetas
    const recipeCache = new Map();
    async function loadRecipeRowsForProduct(prod) {
      const key = prod.id.toString();
      if (recipeCache.has(key)) return recipeCache.get(key);
      const rows = await ProductRecipe.find({ product: prod._id });
      recipeCache.set(key, rows);
      return rows;
    }

    let refundTotal = 0;
    const returnItems = [];
    const invMovesToCreate = [];

    for (const x of normalizedReqItems) {
      const si = x.si;
      const qtyReturn = x.qtyReturn;

      const prod = si.product;
      if (!prod) {
        return res.status(400).json({ ok: false, error: "Producto no encontrado en item" });
      }

      // Reembolso por item
      const qtyOriginal = Math.max(1, Number(si.qty || 1));
      const unitTotal = Number(si.line_total || 0) / qtyOriginal;

      let amount = Math.max(0, roundInt(unitTotal * qtyReturn));
      if (x.refundOverride !== null && Number.isFinite(x.refundOverride) && x.refundOverride >= 0) {
        amount = roundInt(x.refundOverride);
      }

      refundTotal += amount;

      returnItems.push({
        sale_item_id: si._id,
        product_id: prod._id,
        name_snapshot: si.name_snapshot || prod.name,
        qty: qtyReturn,
        unit_total: Math.max(0, roundInt(unitTotal)),
        amount,
      });

      // Restock con tipos seguros
      const kind = String(prod.kind || "STANDARD").toUpperCase();

      if (kind === "STANDARD") {
        prod.stock = Number(prod.stock || 0) + qtyReturn;
        await prod.save();

        invMovesToCreate.push({
          product: prod._id,
          qty: qtyReturn,
          note: `Devolución venta ${sale.id}`,
          type: "IN",
          sourceRef: sale.id.toString(),
          user: user.id,
          location: location || null,
          supplierId: null,
          supplierName: null,
          invoiceNumber: null,
          unitCost: null,
          discount: null,
          tax: null,
          lot: null,
          expiryDate: null,
        });
      } else if (kind === "COCKTAIL") {
        const recipeRows = await loadRecipeRowsForProduct(prod);
        if (!recipeRows.length) {
          return res.status(400).json({
            ok: false,
            error: `El cóctel ${prod.name} no tiene receta`,
          });
        }

        for (const r of recipeRows) {
          const ing = await Product.findById(r.ingredient);
          if (!ing) {
            return res.status(400).json({
              ok: false,
              error: `Ingrediente ${r.ingredient.toString()} no existe`,
            });
          }

          const conv = recipeQtyToCanonical(ing, r.role, r.qty, r.unit);
          if (!conv.ok) {
            return res.status(400).json({ ok: false, error: conv.error });
          }

          const add = Math.ceil(conv.qty * qtyReturn);

          ing.stock = Number(ing.stock || 0) + add;
          await ing.save();

          invMovesToCreate.push({
            product: ing._id,
            qty: add,
            note: `Devolución venta ${sale.id}`,
            type: "IN",
            sourceRef: sale.id.toString(),
            user: user.id,
            location: location || null,
            supplierId: null,
            supplierName: null,
            invoiceNumber: null,
            unitCost: null,
            discount: null,
            tax: null,
            lot: null,
            expiryDate: null,
          });
        }
      } else {
        prod.stock = Number(prod.stock || 0) + qtyReturn;
        await prod.save();

        invMovesToCreate.push({
          product: prod._id,
          qty: qtyReturn,
          note: `Devolución venta ${sale.id}`,
          type: "IN",
          sourceRef: sale.id.toString(),
          user: user.id,
          location: location || null,
          supplierId: null,
          supplierName: null,
          invoiceNumber: null,
          unitCost: null,
          discount: null,
          tax: null,
          lot: null,
          expiryDate: null,
        });
      }
    }

    if (invMovesToCreate.length > 0) {
      await InventoryMove.insertMany(invMovesToCreate);
    }

    const payload = {
      sale: sale._id,
      user: user.id,
      items: returnItems,
      amount: Math.max(0, roundInt(refundTotal)),
      note: note ? String(note).slice(0, 500) : null,
      record_refund_payment: !!record_refund_payment,
    };

    // Compatibilidad legacy cuando es 1 item
    if (normalizedReqItems.length === 1) {
      payload.sale_item = normalizedReqItems[0].si._id;
      payload.qty = normalizedReqItems[0].qtyReturn;
      payload.refund_amount = Math.max(0, roundInt(refundTotal));
    }

    const doc = await SaleReturn.create(payload);

    // Pago de reembolso sin bloquear devolución
    if (record_refund_payment) {
      try {
        await Payment.create({
          sale: sale._id,
          method: "CASH",
          provider: null,
          amount: -Math.abs(roundInt(refundTotal)),
          change_given: 0,
          reference: "REFUND",
        });
      } catch (e) {
        console.error("Error al registrar pago de reembolso:", e.message);
      }
    }

    return res.status(201).json({
      ok: true,
      return: doc.toJSON(),
    });
  } catch (error) {
    console.error("Error al registrar devolución:", error.message);
    return res.status(500).json({ ok: false, error: "Error al registrar devolución" });
  }
}

// Endpoint principal usado por el frontend (con sale_id en body)
router.post("/returns", authMiddleware, async (req, res) => {
  return handleSaleReturn(req, res, null);
});

// Endpoint alterno por id en la URL
router.post("/:id/returns", authMiddleware, async (req, res) => {
  return handleSaleReturn(req, res, req.params.id);
});

// Exporta el router configurado para ventas
module.exports = {
  salesRouter: router,
};

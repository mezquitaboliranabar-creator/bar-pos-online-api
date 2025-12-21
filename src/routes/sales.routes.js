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

// Valida que el usuario autenticado sea administrador
function requireAdmin(req, res, next) {
  const role = String(req?.user?.role || "").toLowerCase();
  if (role !== "admin") {
    return res.status(403).json({ ok: false, error: "Solo admin" });
  }
  next();
}

// Normaliza un id a string comparable
function normId(v) {
  if (v == null) return "";
  return String(v);
}

// Calcula el valor de devolución para un item según la lógica del frontend
function calcRefundAmountForItem(item, qtyReturn) {
  const qtySold = Number(item?.qty || 0);
  const want = Number(qtyReturn || 0);

  if (!Number.isFinite(qtySold) || qtySold <= 0) return { unit_total: 0, amount: 0 };
  if (!Number.isFinite(want) || want <= 0) return { unit_total: 0, amount: 0 };

  const unit_price = Number(item?.unit_price || 0);
  const line_discount = Number(item?.line_discount || 0);
  const tax_rate = Number(item?.tax_rate || 0);

  const unitDisc = line_discount > 0 ? Math.floor(line_discount / qtySold) : 0;
  const unitBase = Math.max(0, unit_price - unitDisc);
  const unitTax = Math.round((unitBase * tax_rate) / 100);
  const unitTotal = unitBase + unitTax;

  return { unit_total: unitTotal, amount: unitTotal * want };
}

// Redondea un valor numérico a entero
function roundInt(v) {
  return Math.round(Number(v || 0));
}

// Convierte un valor a número válido o 0
function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Normaliza un string de fecha YYYY-MM-DD (sin hora)
function normalizeRangeDate(s) {
  const str = String(s || "").trim();
  if (!str) return null;
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// Retorna el inicio del día local para una fecha YYYY-MM-DD
function startOfDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d;
}

// Retorna el final del día local para una fecha YYYY-MM-DD
function endOfDay(dateStr) {
  const d = new Date(`${dateStr}T23:59:59.999`);
  return d;
}

// Mapea kind a inv_type esperado en conversiones
function mapKindToInvType(kind) {
  const k = String(kind || "").toUpperCase();
  if (k === "BASE") return "BASE";
  if (k === "ACCOMP") return "ACCOMP";
  if (k === "COCKTAIL") return "COCKTAIL";
  return "STANDARD";
}

// Categoriza la unidad de medida
function unitCategory(unit) {
  const u = String(unit || "").toUpperCase();
  if (["ML", "L", "OZ"].includes(u)) return "VOLUME";
  if (["G", "KG", "LB"].includes(u)) return "MASS";
  if (["UNIT"].includes(u)) return "COUNT";
  return null;
}

const VOL_TO_ML = {
  ML: 1,
  L: 1000,
  OZ: 29.5735,
};

const MASS_TO_G = {
  G: 1,
  KG: 1000,
  LB: 453.592,
};

// Convierte una cantidad en una unidad a su medida canónica según el producto
function toCanonicalQty(product, qty, unit) {
  const invType = mapKindToInvType(product?.kind);
  const q = Number(qty || 0);
  if (!Number.isFinite(q) || q <= 0) return { ok: false, error: "Cantidad inválida" };

  const u = String(unit || "").toUpperCase();
  const cat = unitCategory(u);

  if (invType === "STANDARD") {
    const m = String(product?.measure || "UNIT").toUpperCase();
    const mCat = unitCategory(m);

    if (mCat === "COUNT") {
      if (cat && cat !== "COUNT") return { ok: false, error: "Unidad inválida para producto" };
      return { ok: true, qty: Math.ceil(q) };
    }

    if (mCat === "VOLUME") {
      if (cat !== "VOLUME") return { ok: false, error: "Unidad inválida para volumen" };
      const f = VOL_TO_ML[u];
      if (!f) return { ok: false, error: `Unidad volumen inválida: ${u}` };
      return { ok: true, qty: Math.ceil(q * f) };
    }

    if (mCat === "MASS") {
      if (cat !== "MASS") return { ok: false, error: "Unidad inválida para masa" };
      const f = MASS_TO_G[u];
      if (!f) return { ok: false, error: `Unidad masa inválida: ${u}` };
      return { ok: true, qty: Math.ceil(q * f) };
    }
  }

  if (cat === "COUNT") {
    return { ok: true, qty: Math.ceil(q) };
  }

  if (cat === "VOLUME") {
    const f = VOL_TO_ML[u];
    if (!f) return { ok: false, error: `Unidad volumen inválida: ${u}` };
    return { ok: true, qty: Math.ceil(q * f) };
  }

  if (cat === "MASS") {
    const f = MASS_TO_G[u];
    if (!f) return { ok: false, error: `Unidad masa inválida: ${u}` };
    return { ok: true, qty: Math.ceil(q * f) };
  }

  return { ok: false, error: "Medida no soportada" };
}

// Convierte cantidades de receta a cantidad canónica para el ingrediente
function recipeQtyToCanonical(ingredientProduct, role, qty, unit) {
  const ingKind = String(ingredientProduct?.kind || "").toUpperCase();
  const r = String(role || "BASE").toUpperCase();

  const asRole = r === "ACCOMP" ? "ACCOMP" : "BASE";
  const invType = ingKind === "ACCOMP" || asRole === "ACCOMP" ? "ACCOMP" : "BASE";

  const q = Number(qty || 0);
  if (!Number.isFinite(q) || q <= 0) return { ok: false, error: "Cantidad inválida en receta" };

  const u = String(unit || "").toUpperCase();
  const cat = unitCategory(u);

  if (invType === "BASE") {
    if (cat !== "VOLUME") return { ok: false, error: "Unidad inválida en receta (BASE)" };
    const f = VOL_TO_ML[u];
    if (!f) return { ok: false, error: `Unidad volumen inválida: ${u}` };
    return { ok: true, qty: q * f };
  }

  if (invType === "ACCOMP") {
    const m = String(ingredientProduct?.measure || "UNIT").toUpperCase();
    const mCat = unitCategory(m);

    if (mCat === "COUNT") {
      if (cat && cat !== "COUNT") return { ok: false, error: "Unidad inválida en receta (ACCOMP)" };
      return { ok: true, qty: q };
    }

    if (mCat === "VOLUME") {
      if (cat !== "VOLUME") return { ok: false, error: "Unidad inválida en receta (ACCOMP)" };
      const f = VOL_TO_ML[u];
      if (!f) return { ok: false, error: `Unidad volumen inválida: ${u}` };
      return { ok: true, qty: q * f };
    }

    if (mCat === "MASS") {
      if (cat !== "MASS") return { ok: false, error: "Unidad inválida en receta (ACCOMP)" };
      const f = MASS_TO_G[u];
      if (!f) return { ok: false, error: `Unidad masa inválida: ${u}` };
      return { ok: true, qty: q * f };
    }

    return { ok: false, error: "Medida de acompañamiento no soportada" };
  }

  return { ok: false, error: "Tipo de receta no soportado" };
}

// Calcula totales de línea (gross, discount, base, tax, total)
function calcLineTotals(unit_price, qty, line_discount, tax_rate) {
  const p = asNumber(unit_price);
  const q = Math.max(1, Math.round(asNumber(qty)));
  const disc = Math.max(0, asNumber(line_discount));
  const tax = Math.max(0, asNumber(tax_rate));

  const gross = roundInt(p * q);
  const discount = roundInt(disc);
  const base = Math.max(0, gross - discount);
  const tax_amount = roundInt((base * tax) / 100);
  const total = base + tax_amount;

  return { gross, discount, base, tax: tax_amount, total };
}

// Crea una venta (simple)
router.post("/", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    const { items, payments, note, location } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Items requeridos" });
    }

    const productIds = items.map((it) => it.product_id).filter(Boolean);
    const products = await Product.find({ _id: { $in: productIds } });

    const productMap = new Map(products.map((p) => [p.id.toString(), p]));
    const itemRows = [];

    let subtotal_gross = 0;
    let discount_total = 0;
    let base_total = 0;
    let tax_total = 0;
    let total = 0;

    for (const it of items) {
      const pid = String(it.product_id || "");
      const prod = productMap.get(pid);

      if (!prod) {
        return res.status(400).json({ ok: false, error: "Producto inválido en items" });
      }

      const qty = Math.max(1, Math.round(asNumber(it.qty)));
      const price =
        typeof it.unit_price === "number"
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

      prod.stock = available - qty;

      itemRows.push({
        product: prod._id,
        name_snapshot: prod.name,
        kind_snapshot: prod.kind,
        measure_snapshot: prod.measure,
        qty,
        unit_price: price,
        line_discount: roundInt(it.line_discount || 0),
        tax_rate: roundInt(it.tax_rate || 0),
        gross,
        discount,
        base,
        tax,
        total: line_total,
        added_at: it.added_at ? new Date(it.added_at) : new Date(),
      });

      subtotal_gross += gross;
      discount_total += discount;
      base_total += base;
      tax_total += tax;
      total += line_total;
    }

    await Promise.all(products.map((p) => p.save()));

    const sale = await Sale.create({
      user: user.id,
      location: location || null,
      note: note || null,
      status: "COMPLETED",
      subtotal_gross: roundInt(subtotal_gross),
      discount_total: roundInt(discount_total),
      base_total: roundInt(base_total),
      tax_total: roundInt(tax_total),
      total: roundInt(total),
    });

    const createdItems = await SaleItem.insertMany(
      itemRows.map((r) => ({ ...r, sale: sale._id }))
    );

    const payRows = Array.isArray(payments) ? payments : [];
    const createdPays = [];

    for (const p of payRows) {
      const amount = roundInt(p.amount || 0);
      if (amount <= 0) continue;

      createdPays.push({
        sale: sale._id,
        method: String(p.method || "CASH").toUpperCase(),
        provider: p.provider ? String(p.provider) : null,
        amount,
        change_given: roundInt(p.change_given || 0),
        reference: p.reference ? String(p.reference) : null,
      });
    }

    if (createdPays.length) {
      await Payment.insertMany(createdPays);
    }

    await InventoryMove.insertMany(
      createdItems.map((it) => ({
        product: it.product,
        qty: -Math.abs(Number(it.qty || 0)),
        note: `Venta ${sale.id}`,
        type: "OUT",
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
      }))
    );

    const finalSale = await Sale.findById(sale._id).populate("user", "username name role");
    const finalItems = await SaleItem.find({ sale: sale._id });
    const finalPays = await Payment.find({ sale: sale._id });

    return res.json({
      ok: true,
      sale: finalSale ? finalSale.toJSON() : sale.toJSON(),
      items: finalItems.map((i) => i.toJSON()),
      payments: finalPays.map((p) => p.toJSON()),
    });
  } catch (error) {
    console.error("Error al crear venta:", error.message);
    return res.status(500).json({ ok: false, error: "Error al crear venta" });
  }
});

// Crea una venta validando recetas de cócteles y consumiendo ingredientes
router.post("/with-recipes", authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    const { items, payments, note, location } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Items requeridos" });
    }

    const normalized = items
      .map((it) => ({
        product_id: it.product_id,
        qty: Math.max(1, Math.round(asNumber(it.qty))),
        unit_price: typeof it.unit_price === "number" ? Number(it.unit_price) : null,
        line_discount: roundInt(it.line_discount || 0),
        tax_rate: roundInt(it.tax_rate || 0),
        added_at: it.added_at ? new Date(it.added_at) : new Date(),
      }))
      .filter((it) => it.product_id);

    const uniqueIds = [...new Set(normalized.map((it) => String(it.product_id)))];
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

    let subtotal_gross = 0;
    let discount_total = 0;
    let base_total = 0;
    let tax_total = 0;
    let total = 0;

    for (const it of normalized) {
      const prod = productMap.get(String(it.product_id));
      if (!prod) {
        return res.status(400).json({ ok: false, error: "Producto inválido en items" });
      }

      const qty = Math.max(1, Math.round(asNumber(it.qty)));
      const price =
        typeof it.unit_price === "number" && Number.isFinite(it.unit_price)
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

      itemRowsTmp.push({
        product: prod._id,
        name_snapshot: prod.name,
        kind_snapshot: prod.kind,
        measure_snapshot: prod.measure,
        qty,
        unit_price: price,
        line_discount: roundInt(it.line_discount || 0),
        tax_rate: roundInt(it.tax_rate || 0),
        gross,
        discount,
        base,
        tax,
        total: line_total,
        added_at: it.added_at ? new Date(it.added_at) : new Date(),
      });

      subtotal_gross += gross;
      discount_total += discount;
      base_total += base;
      tax_total += tax;
      total += line_total;
    }

    for (const mv of invPlan) {
      const prod = await Product.findById(mv.productId);
      if (!prod) {
        return res.status(400).json({ ok: false, error: "Producto no existe" });
      }

      const currentStock = Number(prod.stock || 0);
      const nextStock = currentStock + Number(mv.qty || 0);

      if (nextStock < 0) {
        return res.status(400).json({
          ok: false,
          error: "Stock insuficiente",
          product_id: prod.id,
          requested: Math.abs(Number(mv.qty || 0)),
          available: currentStock,
        });
      }

      prod.stock = nextStock;
      await prod.save();
    }

    const sale = await Sale.create({
      user: user.id,
      location: location || null,
      note: note || null,
      status: "COMPLETED",
      subtotal_gross: roundInt(subtotal_gross),
      discount_total: roundInt(discount_total),
      base_total: roundInt(base_total),
      tax_total: roundInt(tax_total),
      total: roundInt(total),
    });

    const createdItems = await SaleItem.insertMany(
      itemRowsTmp.map((r) => ({ ...r, sale: sale._id }))
    );

    const payRows = Array.isArray(payments) ? payments : [];
    const createdPays = [];

    for (const p of payRows) {
      const amount = roundInt(p.amount || 0);
      if (amount <= 0) continue;

      createdPays.push({
        sale: sale._id,
        method: String(p.method || "CASH").toUpperCase(),
        provider: p.provider ? String(p.provider) : null,
        amount,
        change_given: roundInt(p.change_given || 0),
        reference: p.reference ? String(p.reference) : null,
      });
    }

    if (createdPays.length) {
      await Payment.insertMany(createdPays);
    }

    await InventoryMove.insertMany(
      invPlan.map((mv) => ({
        product: mv.productId,
        qty: Number(mv.qty || 0),
        note: `Venta ${sale.id}`,
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
      }))
    );

    const finalSale = await Sale.findById(sale._id).populate("user", "username name role");
    const finalItems = await SaleItem.find({ sale: sale._id });
    const finalPays = await Payment.find({ sale: sale._id });

    return res.json({
      ok: true,
      sale: finalSale ? finalSale.toJSON() : sale.toJSON(),
      items: finalItems.map((i) => i.toJSON()),
      payments: finalPays.map((p) => p.toJSON()),
    });
  } catch (error) {
    console.error("Error al crear venta con recetas:", error.message);
    return res.status(500).json({ ok: false, error: "Error al crear venta con recetas" });
  }
});

// Lista de ventas con filtros (fecha, estado)
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { start, end, status, q } = req.query;

    const startStr = normalizeRangeDate(start);
    const endStr = normalizeRangeDate(end);

    const filter = {};

    if (startStr || endStr) {
      filter.createdAt = {};
      if (startStr) filter.createdAt.$gte = startOfDay(startStr);
      if (endStr) filter.createdAt.$lte = endOfDay(endStr);
    }

    if (status && String(status).toUpperCase() !== "ALL") {
      filter.status = String(status).toUpperCase();
    }

    if (q) {
      const s = String(q).trim();
      if (s) {
        filter.$or = [
          { location: { $regex: s, $options: "i" } },
          { note: { $regex: s, $options: "i" } },
        ];
      }
    }

    const rows = await Sale.find(filter)
      .sort({ createdAt: -1 })
      .limit(500)
      .populate("user", "username name role");

    return res.json({ ok: true, sales: rows.map((r) => r.toJSON()) });
  } catch (error) {
    console.error("Error al listar ventas:", error.message);
    return res.status(500).json({ ok: false, error: "Error al listar ventas" });
  }
});

// Reporte de ventas por rango
router.get("/report", authMiddleware, async (req, res) => {
  try {
    const { start, end } = req.query;

    const startStr = normalizeRangeDate(start);
    const endStr = normalizeRangeDate(end);

    if (!startStr || !endStr) {
      return res.status(400).json({ ok: false, error: "start y end requeridos" });
    }

    const from = startOfDay(startStr);
    const to = endOfDay(endStr);

    const rows = await Sale.find({ createdAt: { $gte: from, $lte: to } })
      .sort({ createdAt: -1 })
      .populate("user", "username name role");

    return res.json({ ok: true, sales: rows.map((r) => r.toJSON()) });
  } catch (error) {
    console.error("Error al generar reporte:", error.message);
    return res.status(500).json({ ok: false, error: "Error al generar reporte" });
  }
});

// Anula una venta y revierte el stock usando los movimientos asociados
router.post("/:id/void", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const sale = await Sale.findById(id);
    if (!sale) {
      return res.status(404).json({ ok: false, error: "Venta no encontrada" });
    }

    const currentStatus = String(sale.status || "").toUpperCase();
    if (currentStatus === "VOIDED") {
      return res.json({ ok: true, sale: sale.toJSON() });
    }

    const returnsCount = await SaleReturn.countDocuments({ sale: sale._id });
    if (returnsCount > 0) {
      return res.status(400).json({
        ok: false,
        error: "No se puede anular una venta con devoluciones",
      });
    }

    const sourceRef = sale.id.toString();
    const moves = await InventoryMove.find({ sourceRef });

    const headerNote = `Anulación venta ${sale.id}`;

    for (const mv of moves) {
      const prod = await Product.findById(mv.product);
      if (!prod) continue;

      const delta = -Number(mv.qty || 0);
      if (!Number.isFinite(delta) || delta === 0) continue;

      const currentStock = Number(prod.stock || 0);
      prod.stock = currentStock + delta;
      await prod.save();

      await InventoryMove.create({
        product: prod._id,
        qty: delta,
        note: headerNote,
        type: "VOID_REVERSAL",
        sourceRef,
        user: user.id,
        location: mv.location || null,
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

    sale.status = "VOIDED";
    await sale.save();

    return res.json({ ok: true, sale: sale.toJSON() });
  } catch (error) {
    console.error("Error al anular venta:", error.message);
    return res.status(500).json({ ok: false, error: "Error al anular venta" });
  }
});

// Registra una devolución parcial o total y ajusta inventario
async function handleSaleReturn(req, res, saleIdOverride) {
  try {
    const user = req.user;

    const { sale_id, items, note, record_refund_payment, location } = req.body || {};
    const saleId = normId(saleIdOverride || sale_id);

    if (!saleId) {
      return res.status(400).json({ ok: false, error: "sale_id requerido" });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Items requeridos" });
    }

    const sale = await Sale.findById(saleId).populate("user", "username name role");
    if (!sale) {
      return res.status(404).json({ ok: false, error: "Venta no encontrada" });
    }

    const st = String(sale.status || "").toUpperCase();
    if (st === "VOIDED" || st === "REFUNDED") {
      return res
        .status(400)
        .json({ ok: false, error: "Estado de venta no permite devolución" });
    }

    const saleItems = await SaleItem.find({ sale: sale._id }).populate("product");
    const existingReturns = await SaleReturn.find({ sale: sale._id });

    const returnedByItem = {};
    for (const r of existingReturns) {
      const arr = Array.isArray(r.items) ? r.items : [];
      if (arr.length > 0) {
        for (const it of arr) {
          const k = normId(
            it.sale_item_id ||
              it.saleItemId ||
              it.sale_item ||
              it.saleItem ||
              it.sale_item_id
          );
          const q = Number(it.qty || 0);
          if (!k || !Number.isFinite(q) || q <= 0) continue;
          returnedByItem[k] = (returnedByItem[k] || 0) + q;
        }
      } else {
        const k = normId(r.sale_item_id || r.saleItemId || r.sale_item || r.saleItem);
        const q = Number(r.qty || 0);
        if (k && Number.isFinite(q) && q > 0) {
          returnedByItem[k] = (returnedByItem[k] || 0) + q;
        }
      }
    }

    const itemMap = new Map(saleItems.map((it) => [normId(it.id), it]));

    const normalizedLines = [];
    for (const raw of items) {
      const sid = normId(raw.sale_item_id || raw.saleItemId || raw.sale_item || raw.saleItem);
      const want = Math.max(0, Math.floor(Number(raw.qty || 0)));
      if (!sid || want <= 0) continue;

      const si = itemMap.get(sid);
      if (!si) {
        return res.status(400).json({ ok: false, error: `sale_item_id inválido: ${sid}` });
      }

      const sold = Number(si.qty || 0);
      const already = Number(returnedByItem[sid] || 0);
      const remaining = Math.max(0, sold - already);

      if (want > remaining) {
        return res.status(400).json({
          ok: false,
          error: `Cantidad a devolver excede disponible para item ${sid}`,
        });
      }

      normalizedLines.push({ sid, want, saleItem: si });
    }

    if (normalizedLines.length === 0) {
      return res.status(400).json({ ok: false, error: "Nada para devolver" });
    }

    const invPlan = [];
    const retItemsForDoc = [];

    let refundAmount = 0;

    for (const line of normalizedLines) {
      const si = line.saleItem;
      const prod = si.product;

      const refund = calcRefundAmountForItem(si, line.want);
      refundAmount += refund.amount;

      retItemsForDoc.push({
        sale_item_id: normId(si.id),
        product_id: prod ? normId(prod.id) : null,
        name_snapshot: si.name_snapshot || null,
        qty: line.want,
        unit_total: refund.unit_total,
        amount: refund.amount,
      });

      if (prod && String(prod.kind || "STANDARD").toUpperCase() === "COCKTAIL") {
        const recipeRows = await ProductRecipe.find({ product: prod._id });
        if (recipeRows.length > 0) {
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
            const need = Math.ceil(conv.qty * Math.max(1, Math.round(line.want)));
            const moveType =
              String(r.role || "BASE").toUpperCase() === "ACCOMP"
                ? "RETURN_ACCOMP"
                : "RETURN_RECIPE";

            invPlan.push({
              productId: ing._id,
              qty: need,
              type: moveType,
              label: ing.name,
            });
          }
          continue;
        }
      }

      if (prod) {
        const conv = toCanonicalQty(prod, line.want, prod.measure || "UNIT");
        if (!conv.ok) {
          return res.status(400).json({ ok: false, error: conv.error });
        }
        invPlan.push({
          productId: prod._id,
          qty: Math.ceil(conv.qty),
          type: "RETURN",
          label: prod.name,
        });
      }
    }

    const headerNote = `Devolución venta ${sale.id}`;

    for (const mv of invPlan) {
      const prod = await Product.findById(mv.productId);
      if (!prod) {
        return res.status(400).json({
          ok: false,
          error: "Producto de inventario no encontrado para movimiento",
        });
      }

      const currentStock = Number(prod.stock || 0);
      const nextStock = currentStock + Number(mv.qty || 0);

      prod.stock = nextStock;
      await prod.save();

      await InventoryMove.create({
        product: prod._id,
        qty: Number(mv.qty || 0),
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

    const saleReturn = await SaleReturn.create({
      sale: sale._id,
      user: user.id,
      note: note || null,
      items: retItemsForDoc,
      amount: refundAmount,
      record_refund_payment: !!record_refund_payment,
    });

    if (record_refund_payment) {
      await Payment.create({
        sale: sale._id,
        method: "CASH",
        provider: null,
        amount: -Math.abs(refundAmount),
        change_given: 0,
        reference: "REFUND",
      });
    }

    const returnedByItemNext = { ...returnedByItem };
    for (const line of normalizedLines) {
      returnedByItemNext[line.sid] = (returnedByItemNext[line.sid] || 0) + line.want;
    }

    const fullyReturned = saleItems.every((it) => {
      const sold = Number(it.qty || 0);
      const done = Number(returnedByItemNext[normId(it.id)] || 0);
      return sold > 0 ? done >= sold : true;
    });

    if (fullyReturned) {
      sale.status = "REFUNDED";
      await sale.save();
    }

    const freshReturns = await SaleReturn.find({ sale: sale._id });

    return res.json({
      ok: true,
      sale: sale.toJSON(),
      returns: freshReturns.map((r) => r.toJSON()),
      refund_amount: refundAmount,
      return: saleReturn.toJSON(),
    });
  } catch (error) {
    console.error("Error al registrar devolución:", error.message);
    return res.status(500).json({ ok: false, error: "Error al registrar devolución" });
  }
}

router.post("/returns", authMiddleware, requireAdmin, async (req, res) => {
  return handleSaleReturn(req, res, null);
});

router.post("/:id/returns", authMiddleware, requireAdmin, async (req, res) => {
  return handleSaleReturn(req, res, req.params.id);
});

// Obtiene el detalle de una venta con ítems, pagos y devoluciones
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const sale = await Sale.findById(id).populate("user", "username name role");
    if (!sale) {
      return res.status(404).json({ ok: false, error: "Venta no encontrada" });
    }

    const items = await SaleItem.find({ sale: sale._id });
    const payments = await Payment.find({ sale: sale._id });
    const returns = await SaleReturn.find({ sale: sale._id });

    return res.json({
      ok: true,
      sale: sale.toJSON(),
      items: items.map((i) => i.toJSON()),
      payments: payments.map((p) => p.toJSON()),
      returns: returns.map((r) => r.toJSON()),
    });
  } catch (error) {
    console.error("Error al obtener detalle de venta:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener detalle de venta" });
  }
});

module.exports = router;

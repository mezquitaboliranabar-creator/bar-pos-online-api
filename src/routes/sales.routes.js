const express = require("express");
const { authMiddleware } = require("./auth.routes");
const Sale = require("../models/Sale");
const SaleItem = require("../models/SaleItem");
const Payment = require("../models/Payment");
const SaleReturn = require("../models/SaleReturn");
const Product = require("../models/Product");
const InventoryMove = require("../models/InventoryMove");
const ProductRecipe = require("../models/ProductRecipe");
const Expense = require("../models/Expense");

// Crea el router para agrupar las rutas de ventas
const router = express.Router();

// Redondea un valor numérico a entero
function roundInt(v) {
  return Math.round(Number(v || 0));
}

// Calcula totales de línea para un item de venta
function calcLineTotals(unit_price, qty, line_discount, tax_rate) {
  const gross = unit_price * qty;
  const discount = Math.min(Math.max(line_discount || 0, 0), gross);
  const net = gross - discount;
  const tax = net * (tax_rate || 0);
  const total = net + tax;

  return {
    gross,
    discount,
    net,
    tax,
    total,
  };
}

// Normaliza fecha yyyy-mm-dd a rango completo del día
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

// Obtiene el resumen de gastos agrupado por método y proveedor
async function aggregateExpensesSummary(filter) {
  const match = { ...filter };

  if (Array.isArray(match.$and)) {
    match.$and = [...match.$and, { status: "ACTIVE" }];
  } else {
    match.status = "ACTIVE";
  }

  const pipeline = [
    { $match: match },
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

  const rows = await Expense.aggregate(pipeline);
  return rows;
}

// Crea un item de venta a partir de un producto
function buildSaleItemFromProduct(product, qty, line_discount_pct, line_tax_pct) {
  const unit_price = Number(product.price || 0);
  const q = Math.max(1, Number(qty || 1));
  const gross = unit_price * q;

  const pct = Math.max(0, Math.min(100, Number(line_discount_pct || 0)));
  const line_discount = (gross * pct) / 100;

  const taxRate = Math.max(0, Number(line_tax_pct || 0)) / 100;

  const totals = calcLineTotals(unit_price, q, line_discount, taxRate);

  return {
    product_id: product.id,
    productId: product.id,
    name: product.name,
    qty: q,
    unit_price: unit_price,
    line_discount: roundInt(totals.discount),
    tax_rate: Number(line_tax_pct || 0),
    gross: roundInt(totals.gross),
    net: roundInt(totals.net),
    tax: roundInt(totals.tax),
    total: roundInt(totals.total),
  };
}

// Crea una venta normalizada desde request
async function buildSalePayload(reqBody) {
  const items = Array.isArray(reqBody.items) ? reqBody.items : [];
  const payments = Array.isArray(reqBody.payments) ? reqBody.payments : [];
  const status = reqBody.status ? String(reqBody.status).toUpperCase() : "PAID";

  const normalizedItems = [];
  let subtotal = 0;
  let discount_total = 0;
  let tax_total = 0;
  let total = 0;

  for (const it of items) {
    const productId = it.productId || it.product_id || it.product;
    const qty = it.qty || it.quantity || 1;

    const product = await Product.findById(productId);
    if (!product) {
      const err = new Error("Producto no encontrado");
      err.status = 400;
      throw err;
    }

    const line_discount_pct = it.line_discount_pct ?? it.discount_pct ?? 0;
    const line_tax_pct = it.line_tax_pct ?? it.tax_pct ?? 0;

    const saleItem = buildSaleItemFromProduct(product, qty, line_discount_pct, line_tax_pct);

    normalizedItems.push(saleItem);

    subtotal += Number(saleItem.net || 0);
    discount_total += Number(saleItem.line_discount || 0);
    tax_total += Number(saleItem.tax || 0);
    total += Number(saleItem.total || 0);
  }

  const normalizedPayments = [];
  let paid = 0;

  for (const p of payments) {
    const method = String(p.method || "").toUpperCase();
    const provider = p.provider ? String(p.provider).toUpperCase() : null;
    const reference = p.reference ? String(p.reference).trim() : null;
    const amount = roundInt(p.amount);

    normalizedPayments.push({ method, provider, amount, reference });
    paid += amount;
  }

  return {
    status,
    subtotal: roundInt(subtotal),
    discount_total: roundInt(discount_total),
    tax_total: roundInt(tax_total),
    total: roundInt(total),
    paid: roundInt(paid),
    change: roundInt(paid - total),
    items: normalizedItems,
    payments: normalizedPayments,
  };
}

// Obtiene los ids de productos únicos de una lista de items
function collectUniqueProductIds(items) {
  const ids = [];
  for (const it of items) {
    const pid = it.productId || it.product_id || it.product;
    if (pid) ids.push(String(pid));
  }
  return [...new Set(ids)];
}

// Rellena mapa de productos por id para acceso rápido
async function buildProductsMap(ids) {
  const products = await Product.find({ _id: { $in: ids } });
  return new Map(products.map((p) => [p.id.toString(), p]));
}

// Obtiene recetas por producto si aplica
async function buildRecipeMap(productIds) {
  const recipes = await ProductRecipe.find({ product_id: { $in: productIds } });
  const map = new Map();
  for (const r of recipes) {
    const k = String(r.product_id);
    map.set(k, r);
  }
  return map;
}

// Valida disponibilidad de ingredientes según receta
async function validateRecipeStock(productMap, recipeMap, items) {
  for (const it of items) {
    const pid = it.productId || it.product_id || it.product;
    const key = String(pid || "");
    const recipe = recipeMap.get(key);
    if (!recipe) continue;

    const qty = Number(it.qty || it.quantity || 1);
    const ingredients = Array.isArray(recipe.items) ? recipe.items : [];

    for (const ing of ingredients) {
      const ingredientProductId = ing.product_id || ing.productId || ing.product;
      if (!ingredientProductId) continue;

      const ingredient = productMap.get(String(ingredientProductId));
      if (!ingredient) continue;

      const need = Number(ing.qty || 0) * qty;
      const stock = Number(ingredient.stock || 0);

      if (stock < need) {
        const err = new Error("Stock insuficiente para preparar el producto");
        err.status = 400;
        throw err;
      }
    }
  }
}

// Aplica movimientos de inventario (salida) para una venta
async function applyInventoryOutForSale(sale, productMap, recipeMap) {
  const moves = [];

  for (const it of sale.items || []) {
    const pid = it.productId || it.product_id || it.product;
    const key = String(pid || "");
    const recipe = recipeMap.get(key);

    if (!recipe) {
      const product = productMap.get(key);
      if (!product) continue;

      moves.push({
        type: "OUT",
        product_id: product.id,
        qty: Number(it.qty || 1),
        note: `Venta ${sale.id}`,
        sale_id: sale.id,
      });

      continue;
    }

    const ingredients = Array.isArray(recipe.items) ? recipe.items : [];
    for (const ing of ingredients) {
      const ingredientProductId = ing.product_id || ing.productId || ing.product;
      if (!ingredientProductId) continue;

      const ingKey = String(ingredientProductId);
      const ingredient = productMap.get(ingKey);
      if (!ingredient) continue;

      const need = Number(ing.qty || 0) * Number(it.qty || 1);

      moves.push({
        type: "OUT",
        product_id: ingredient.id,
        qty: need,
        note: `Venta ${sale.id} (receta)`,
        sale_id: sale.id,
      });
    }
  }

  if (moves.length === 0) return [];

  const created = await InventoryMove.insertMany(moves, { ordered: true });
  return created;
}

// Crea pagos asociados a una venta
async function createPaymentsForSale(sale, payments) {
  const docs = [];
  for (const p of payments || []) {
    docs.push({
      sale_id: sale.id,
      method: p.method,
      provider: p.provider || null,
      reference: p.reference || null,
      amount: roundInt(p.amount),
    });
  }

  if (docs.length === 0) return [];

  const created = await Payment.insertMany(docs, { ordered: true });
  return created;
}

// Crea items asociados a una venta
async function createItemsForSale(sale, items) {
  const docs = [];
  for (const it of items || []) {
    docs.push({
      sale_id: sale.id,
      product_id: it.productId || it.product_id || it.product,
      name: it.name,
      qty: Number(it.qty || 1),
      unit_price: roundInt(it.unit_price),
      line_discount: roundInt(it.line_discount),
      tax_rate: Number(it.tax_rate || 0),
      gross: roundInt(it.gross),
      net: roundInt(it.net),
      tax: roundInt(it.tax),
      total: roundInt(it.total),
    });
  }

  if (docs.length === 0) return [];

  const created = await SaleItem.insertMany(docs, { ordered: true });
  return created;
}

// Obtiene catálogo de ventas
router.get("/catalog", authMiddleware, async (req, res) => {
  try {
    const products = await Product.find({ active: true }).sort({ name: 1 });
    return res.json({ ok: true, items: products.map((p) => p.toJSON()) });
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

    const [items, expenses_items] = await Promise.all([
      aggregatePaymentsSummary(filter),
      aggregateExpensesSummary(filter),
    ]);

    // Calcula neto por método y proveedor (pagos - gastos)
    const payMap = new Map();
    for (const r of items || []) {
      const key = `${r.method || ""}::${r.provider || ""}`;
      payMap.set(key, Number(r.total || 0));
    }

    const expMap = new Map();
    for (const r of expenses_items || []) {
      const key = `${r.method || ""}::${r.provider || ""}`;
      expMap.set(key, Number(r.total || 0));
    }

    const keys = new Set([...payMap.keys(), ...expMap.keys()]);
    const net_items = [];

    for (const k of keys) {
      const parts = k.split("::");
      const method = parts[0] || "";
      const provider = parts[1] ? parts[1] : null;

      const payTotal = Number(payMap.get(k) || 0);
      const expTotal = Number(expMap.get(k) || 0);

      net_items.push({
        method,
        provider,
        total: payTotal - expTotal,
      });
    }

    net_items.sort((a, b) => {
      const am = String(a.method || "");
      const bm = String(b.method || "");
      if (am !== bm) return am.localeCompare(bm);
      const ap = String(a.provider || "");
      const bp = String(b.provider || "");
      return ap.localeCompare(bp);
    });

    return res.json({
      ok: true,
      items,
      expenses_items,
      net_items,
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
      and.push({ user_id });
    }

    if (and.length > 0) {
      filter.$and = and;
    }

    const sales = await Sale.find(filter);

    // Calcula gastos activos en el mismo rango de fechas
    const expFilter = {};
    const expAnd = [];

    if (startNorm || endNorm) {
      const range = {};
      if (startNorm) range.$gte = new Date(startNorm);
      if (endNorm) range.$lte = new Date(endNorm);
      expAnd.push({ createdAt: range });
    }

    expAnd.push({ status: "ACTIVE" });

    if (user_id) {
      expAnd.push({ createdBy: user_id });
    }

    if (expAnd.length > 0) {
      expFilter.$and = expAnd;
    }

    const expAgg = await Expense.aggregate([
      { $match: expFilter },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
      { $project: { _id: 0, total: 1, count: 1 } },
    ]);

    const expenses_total = expAgg[0] ? roundInt(expAgg[0].total) : 0;
    const expenses_count = expAgg[0] ? Number(expAgg[0].count || 0) : 0;

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
        expenses_total,
        expenses_count,
        net_total: roundInt(sumTotal - expenses_total),
      },
    });
  } catch (error) {
    console.error("Error al obtener reporte de ventas:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener reporte de ventas" });
  }
});

// Lista ventas con filtros
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { start, end, status, q, limit } = req.query;

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

    const qq = String(q || "").trim();
    if (qq) {
      const rx = new RegExp(qq.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      and.push({
        $or: [{ note: rx }, { customer_name: rx }, { customer_phone: rx }],
      });
    }

    if (and.length > 0) {
      filter.$and = and;
    }

    const lim = Math.max(1, Math.min(200, Number(limit) || 50));

    const items = await Sale.find(filter).sort({ createdAt: -1 }).limit(lim);

    return res.json({
      ok: true,
      items: items.map((s) => s.toJSON()),
    });
  } catch (error) {
    console.error("Error al listar ventas:", error.message);
    return res.status(500).json({ ok: false, error: "Error al listar ventas" });
  }
});

// Obtiene una venta por id
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const sale = await Sale.findById(id);
    if (!sale) {
      return res.status(404).json({ ok: false, error: "Venta no encontrada" });
    }

    const items = await SaleItem.find({ sale_id: sale.id }).sort({ createdAt: 1 });
    const payments = await Payment.find({ sale_id: sale.id }).sort({ createdAt: 1 });
    const returns = await SaleReturn.find({ sale: sale.id }).sort({ createdAt: 1 });

    return res.json({
      ok: true,
      sale: sale.toJSON(),
      items: items.map((it) => it.toJSON()),
      payments: payments.map((p) => p.toJSON()),
      returns: returns.map((r) => r.toJSON()),
    });
  } catch (error) {
    console.error("Error al obtener venta:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener venta" });
  }
});

// Crea una venta
router.post("/", authMiddleware, async (req, res) => {
  try {
    const payload = await buildSalePayload(req.body);

    if (!payload.items || payload.items.length === 0) {
      return res.status(400).json({ ok: false, error: "Debe incluir items" });
    }

    const productIds = collectUniqueProductIds(payload.items);
    const productMap = await buildProductsMap(productIds);
    const recipeMap = await buildRecipeMap(productIds);

    await validateRecipeStock(productMap, recipeMap, payload.items);

    const sale = await Sale.create({
      status: payload.status,
      subtotal: payload.subtotal,
      discount_total: payload.discount_total,
      tax_total: payload.tax_total,
      total: payload.total,
      paid: payload.paid,
      change: payload.change,
      note: req.body.note || null,
      user_id: req.user.id,
    });

    const createdItems = await createItemsForSale(sale, payload.items);
    const createdPayments = await createPaymentsForSale(sale, payload.payments);

    await applyInventoryOutForSale(
      { ...sale.toJSON(), id: sale.id, items: payload.items },
      productMap,
      recipeMap
    );

    return res.json({
      ok: true,
      sale: sale.toJSON(),
      items: createdItems.map((it) => it.toJSON()),
      payments: createdPayments.map((p) => p.toJSON()),
    });
  } catch (error) {
    console.error("Error al crear venta:", error.message);
    const code = error.status ? Number(error.status) : 500;
    return res.status(code).json({ ok: false, error: error.message || "Error al crear venta" });
  }
});
// Crea devolución parcial de un item de venta
router.post("/:id/returns", authMiddleware, async (req, res) => {
  try {
    const saleId = String(req.params.id || "");
    const sale_item = req.body?.sale_item;
    const qty = Number(req.body?.qty || 0);
    const refund_amount = roundInt(req.body?.refund_amount);

    if (!sale_item) {
      return res.status(400).json({ ok: false, error: "sale_item requerido" });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ ok: false, error: "Cantidad inválida" });
    }
    if (!Number.isFinite(refund_amount) || refund_amount < 0) {
      return res.status(400).json({ ok: false, error: "Monto inválido" });
    }

    const sale = await Sale.findById(saleId);
    if (!sale) {
      return res.status(404).json({ ok: false, error: "Venta no encontrada" });
    }

    const item = await SaleItem.findById(sale_item);
    if (!item || String(item.sale_id) !== String(sale.id)) {
      return res.status(404).json({ ok: false, error: "Item no encontrado" });
    }

    const created = await SaleReturn.create({
      sale: sale.id,
      sale_item: item.id,
      qty,
      refund_amount,
      note: req.body?.note ?? null,
    });

    return res.json({ ok: true, item: created.toJSON() });
  } catch (error) {
    console.error("Error al crear devolución:", error.message);
    return res.status(500).json({ ok: false, error: "Error al crear devolución" });
  }
});

module.exports = {
  salesRouter: router,
};

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

// Verifica si un modelo tiene un campo en el schema
function hasSchemaPath(Model, path) {
  return Boolean(
    Model &&
      Model.schema &&
      typeof Model.schema.path === "function" &&
      Model.schema.path(path)
  );
}

// Asigna referencia de venta usando los campos disponibles
function attachSaleRef(doc, sale, Model) {
  const saleObjId = sale?._id || sale?.id;
  const saleStr = String(sale?.id || saleObjId || "");

  if (hasSchemaPath(Model, "sale")) doc.sale = saleObjId;
  if (hasSchemaPath(Model, "sale_id")) doc.sale_id = saleStr;

  if (!hasSchemaPath(Model, "sale") && !hasSchemaPath(Model, "sale_id")) {
    doc.sale_id = saleStr;
  }
}

// Redondea un valor numérico a entero
function roundInt(v) {
  return Math.round(Number(v || 0));
}

// Normaliza un string de fecha para rango (ISO)
function normalizeRangeDate(value, isStart) {
  const s = String(value || "").trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = isStart ? "00:00:00.000Z" : "23:59:59.999Z";
    return `${s}T${t}`;
  }

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Convierte a número seguro
function toNumber(v, def = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return n;
}

// Convierte a entero seguro
function toInt(v, def = 0) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return def;
  return n;
}

// Valida array no vacío
function ensureArray(a) {
  return Array.isArray(a) ? a : [];
}

// Extrae ids únicos de productos de items
function collectUniqueProductIds(items) {
  const ids = new Set();
  for (const it of ensureArray(items)) {
    const id = it.productId || it.product_id || it.product;
    if (id) ids.add(String(id));
  }
  return Array.from(ids);
}

// Construye mapa de productos por id
async function buildProductsMap(productIds) {
  if (!productIds || productIds.length === 0) return new Map();
  const products = await Product.find({ _id: { $in: productIds } });
  const map = new Map();
  for (const p of products) map.set(String(p._id), p);
  return map;
}

// Construye mapa de recetas por id producto
async function buildRecipeMap(productIds) {
  if (!productIds || productIds.length === 0) return new Map();
  const recipes = await ProductRecipe.find({ product: { $in: productIds } });
  const map = new Map();
  for (const r of recipes) {
    const k = String(r.product);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

// Valida stock por receta (si aplica)
async function validateRecipeStock(productMap, recipeMap, items) {
  const list = ensureArray(items);

  for (const it of list) {
    const productId = String(it.productId || it.product_id || it.product || "");
    const qty = toInt(it.qty, 1);

    if (!productId) continue;

    const product = productMap.get(productId);
    const recipes = recipeMap.get(productId) || [];

    if (!product) continue;

    if (recipes.length === 0) {
      const stock = toNumber(product.stock, 0);
      if (stock < qty) {
        throw new Error(`Stock insuficiente para ${product.name || "producto"} (${stock})`);
      }
      continue;
    }

    // Si hay receta, validar insumos
    for (const r of recipes) {
      const ing = await Product.findById(r.ingredient);
      if (!ing) continue;

      const need = toNumber(r.qty, 0) * qty;
      const have = toNumber(ing.stock, 0);

      if (have < need) {
        throw new Error(`Stock insuficiente de insumo ${ing.name || "ingrediente"} (${have})`);
      }
    }
  }
}

// Crea movimientos de inventario por receta o producto directo
async function createInventoryMovesForSale(sale, productMap, recipeMap, items) {
  const moves = [];
  const list = ensureArray(items);

  for (const it of list) {
    const productId = String(it.productId || it.product_id || it.product || "");
    const qty = toInt(it.qty, 1);
    if (!productId) continue;

    const product = productMap.get(productId);
    const recipes = recipeMap.get(productId) || [];

    if (!product) continue;

    if (recipes.length === 0) {
      moves.push({
        type: "OUT",
        reason: "SALE",
        product: product._id,
        qty: qty,
        note: `Venta ${sale.id}`,
        ref: { sale_id: sale.id },
      });
      continue;
    }

    for (const r of recipes) {
      moves.push({
        type: "OUT",
        reason: "SALE_RECIPE",
        product: r.ingredient,
        qty: roundInt(toNumber(r.qty, 0) * qty),
        note: `Venta ${sale.id} (${product.name || "producto"})`,
        ref: { sale_id: sale.id },
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
    const doc = {
      method: p.method,
      provider: p.provider || null,
      reference: p.reference || null,
      amount: roundInt(p.amount),
    };

    attachSaleRef(doc, sale, Payment);
    docs.push(doc);
  }
  if (docs.length === 0) return [];

  const created = await Payment.insertMany(docs, { ordered: true });
  return created;
}

// Crea items asociados a una venta
async function createItemsForSale(sale, items) {
  const docs = [];
  for (const it of items || []) {
    const doc = {
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
    };

    attachSaleRef(doc, sale, SaleItem);
    docs.push(doc);
  }

  if (docs.length === 0) return [];

  const created = await SaleItem.insertMany(docs, { ordered: true });
  return created;
}

// Obtiene catálogo de ventas
router.get("/catalog", authMiddleware, async (req, res) => {
  try {
    const products = await Product.find({ active: { $ne: false } }).sort({ name: 1 });
    const expenses = await Expense.find({ active: { $ne: false } }).sort({ name: 1 });

    return res.json({
      ok: true,
      products: products.map((p) => p.toJSON()),
      expenses: expenses.map((e) => e.toJSON()),
    });
  } catch (error) {
    console.error("Error al obtener catálogo:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener catálogo" });
  }
});

// Resume pagos por rango
router.get("/paymentsSummary", authMiddleware, async (req, res) => {
  try {
    const { start, end } = req.query;

    const startNorm = normalizeRangeDate(start, true);
    const endNorm = normalizeRangeDate(end, false);

    const filter = {};
    if (startNorm || endNorm) {
      filter.createdAt = {};
      if (startNorm) filter.createdAt.$gte = new Date(startNorm);
      if (endNorm) filter.createdAt.$lte = new Date(endNorm);
    }

    const agg = await Payment.aggregate([
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
    ]);

    return res.json({ ok: true, items: agg });
  } catch (error) {
    console.error("Error en paymentsSummary:", error.message);
    return res.status(500).json({ ok: false, error: "Error en paymentsSummary" });
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
      filter.createdAt = {};
      if (startNorm) filter.createdAt.$gte = new Date(startNorm);
      if (endNorm) filter.createdAt.$lte = new Date(endNorm);
    }

    if (status) {
      and.push({ status: String(status).toUpperCase() });
    }

    if (q) {
      const s = String(q || "").trim();
      if (s) {
        and.push({
          $or: [
            { client: { $regex: s, $options: "i" } },
            { notes: { $regex: s, $options: "i" } },
          ],
        });
      }
    }

    if (and.length > 0) filter.$and = and;

    const lim = Math.max(1, Math.min(500, toInt(limit, 200)));
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

    const saleIdStr = String(sale.id || sale._id || "");
    const saleIdObj = sale._id || sale.id;

    const items = await SaleItem.find({
      $or: [{ sale_id: saleIdStr }, { sale_id: saleIdObj }, { sale: saleIdObj }, { sale: saleIdStr }],
    }).sort({ createdAt: 1 });

    const payments = await Payment.find({
      $or: [{ sale_id: saleIdStr }, { sale_id: saleIdObj }, { sale: saleIdObj }, { sale: saleIdStr }],
    }).sort({ createdAt: 1 });

    const returns = await SaleReturn.find({
      $or: [{ sale: saleIdObj }, { sale: saleIdStr }, { sale_id: saleIdStr }, { sale_id: saleIdObj }],
    }).sort({ createdAt: 1 });

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
    const payload = req.body || {};

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
      notes: payload.notes || null,
      client: payload.client || null,
      user_id: req.user?.id || req.user?._id,
    });

    await createItemsForSale(sale, payload.items);
    await createPaymentsForSale(sale, payload.payments || []);

    await createInventoryMovesForSale(sale, productMap, recipeMap, payload.items);

    return res.json({ ok: true, sale: sale.toJSON() });
  } catch (error) {
    console.error("Error al crear venta:", error.message);
    return res.status(500).json({ ok: false, error: "Error al crear venta" });
  }
});

// Anula venta
router.post("/:id/void", authMiddleware, async (req, res) => {
  try {
    const saleId = String(req.params.id || "");
    const sale = await Sale.findById(saleId);

    if (!sale) {
      return res.status(404).json({ ok: false, error: "Venta no encontrada" });
    }

    if (sale.status === "VOIDED") {
      return res.status(400).json({ ok: false, error: "La venta ya está anulada" });
    }

    sale.status = "VOIDED";
    await sale.save();

    return res.json({ ok: true, sale: sale.toJSON() });
  } catch (error) {
    console.error("Error al anular venta:", error.message);
    return res.status(500).json({ ok: false, error: "Error al anular venta" });
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

    const item = await SaleItem.findById(String(sale_item));
    if (!item) {
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

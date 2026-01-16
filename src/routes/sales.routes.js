const express = require("express");
const mongoose = require("mongoose");
const { authMiddleware } = require("./auth.routes");
const Sale = require("../models/Sale");
const SaleItem = require("../models/SaleItem");
const Payment = require("../models/Payment");
const SaleReturn = require("../models/SaleReturn");
const Product = require("../models/Product");
const ProductRecipe = require("../models/ProductRecipe");
const Expense = require("../models/Expense");

const router = express.Router();

function roundInt(v) {
  return Math.round(Number(v || 0));
}

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

// Normaliza el payload de venta (calcula totales y normaliza items/pagos)
async function buildSalePayload(body) {
  const status = String(body?.status || "COMPLETED").toUpperCase();
  const items = Array.isArray(body?.items) ? body.items : [];
  const payments = Array.isArray(body?.payments) ? body.payments : [];

  const normalizedItems = [];
  let subtotal = 0;
  let discount_total = 0;
  let tax_total = 0;
  let total = 0;

  for (const it of items) {
    const productId = it.productId || it.product_id || it.product;
    const qty = Number(it.qty || it.quantity || 1);

    const product = await Product.findById(productId);
    if (!product) {
      const err = new Error("Producto no encontrado");
      err.status = 400;
      throw err;
    }

    const unit_price = roundInt(it.unit_price ?? it.unitPrice ?? product.price ?? 0);
    const line_discount = roundInt(it.line_discount ?? it.lineDiscount ?? 0);
    const tax_rate = Number(it.tax_rate ?? it.taxRate ?? 0);

    const net = roundInt(qty * unit_price - line_discount);
    const tax = roundInt((net * tax_rate) / 100);
    const line_total = roundInt(net + tax);

    const name = String(it.name || product.name || "").trim();

    const saleItem = {
      productId: product.id,
      product_id: product.id,
      product: product.id,
      name,
      name_snapshot: name,
      qty,
      unit_price,
      line_discount,
      tax_rate,
      net,
      tax,
      total: line_total,
      line_total: line_total,
    };

    normalizedItems.push(saleItem);

    subtotal += net;
    discount_total += line_discount;
    tax_total += tax;
    total += line_total;
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
    client: body?.client || null,
    note: body?.note || null,
  };
}

function collectUniqueProductIds(items) {
  const ids = [];
  for (const it of items) {
    const pid = it.productId || it.product_id || it.product;
    if (pid) ids.push(String(pid));
  }
  return [...new Set(ids)];
}

async function buildProductsMap(ids) {
  const products = await Product.find({ _id: { $in: ids } });
  return new Map(products.map((p) => [p.id.toString(), p]));
}

async function buildRecipeMap(productIds) {
  const recipes = await ProductRecipe.find({ product_id: { $in: productIds } });
  const map = new Map();
  for (const r of recipes) {
    const k = String(r.product_id);
    map.set(k, r);
  }
  return map;
}

async function validateRecipeStock(productMap, recipeMap, items) {
  for (const it of items) {
    const pid = it.productId || it.product_id || it.product;
    const key = String(pid || "");
    const recipe = recipeMap.get(key);
    const qty = Number(it.qty || it.quantity || 1);

    // Sin receta: valida stock del producto
    if (!recipe) {
      const product = productMap.get(key);
      if (product) {
        const stock = Number(product.stock || 0);
        if (stock < qty) {
          const err = new Error(`Stock insuficiente para ${product.name || "producto"}`);
          err.status = 400;
          throw err;
        }
      }
      continue;
    }

    // Con receta: valida stock de ingredientes
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

// Descuenta stock inmediatamente al cerrar una venta (sin crear movimientos)
async function decrementStockForSale(productMap, recipeMap, items, session) {
  const dec = new Map();

  for (const it of items || []) {
    const pid = it.productId || it.product_id || it.product;
    const key = String(pid || "");
    const qty = Number(it.qty || it.quantity || 1);
    if (!key) continue;

    const recipe = recipeMap.get(key);

    // Sin receta: descuenta producto directo
    if (!recipe) {
      dec.set(key, (dec.get(key) || 0) + qty);
      continue;
    }

    // Con receta: descuenta ingredientes
    const ingredients = Array.isArray(recipe.items) ? recipe.items : [];
    for (const ing of ingredients) {
      const ingredientProductId = ing.product_id || ing.productId || ing.product;
      if (!ingredientProductId) continue;

      const ingKey = String(ingredientProductId);
      const need = Number(ing.qty || 0) * qty;
      if (need > 0) dec.set(ingKey, (dec.get(ingKey) || 0) + need);
    }
  }

  const keys = Array.from(dec.keys()).sort();
  for (const k of keys) {
    const need = roundInt(dec.get(k));
    if (need <= 0) continue;

    const name = productMap.get(String(k))?.name || "producto";

    const r = await Product.updateOne(
      { _id: k, stock: { $gte: need } },
      { $inc: { stock: -need } },
      { session }
    );

    const modified = r && (r.modifiedCount ?? r.nModified ?? 0);
    if (!modified) {
      const err = new Error(`Stock insuficiente para ${name}`);
      err.status = 400;
      throw err;
    }
  }
}

async function createPaymentsForSale(sale, payments, user, session) {
  const docs = [];
  for (const p of payments || []) {
    docs.push({
      sale_id: sale.id,
      sale: sale._id,
      method: p.method,
      provider: p.provider || null,
      reference: p.reference || null,
      amount: roundInt(p.amount),
      user: user?._id || user?.id,
      user_id: user?._id || user?.id,
    });
  }

  if (docs.length === 0) return [];
  return Payment.insertMany(docs, { ordered: true, session });
}

async function createItemsForSale(sale, items, user, session, productMap) {
  const docs = [];
  for (const it of items || []) {
    const productRaw = it.productId || it.product_id || it.product || it._id;
    const qty = Number(it.qty || it.quantity || 1);

    const unitPrice = roundInt(it.unit_price ?? it.unitPrice ?? it.price ?? 0);
    const lineDiscount = roundInt(it.line_discount ?? it.lineDiscount ?? 0);
    const taxRate = Number(it.tax_rate ?? it.taxRate ?? 0);
    const tax = roundInt(it.tax ?? 0);

    const rawTotal = it.total ?? it.line_total ?? it.lineTotal;
    const computedTotal = roundInt(qty * unitPrice - lineDiscount + tax);
    const total = roundInt(rawTotal ?? computedTotal);

    let nameSnapshot = String(it.name_snapshot ?? it.name ?? it.productName ?? "").trim();
    if (!nameSnapshot && productMap) {
      const p = productMap.get(String(productRaw));
      if (p && p.name) nameSnapshot = String(p.name).trim();
    }

    docs.push({
      sale_id: sale.id,
      sale: sale._id,
      product: productRaw,
      product_id: productRaw,
      name_snapshot: nameSnapshot,
      name: nameSnapshot,
      qty,
      unit_price: unitPrice,
      line_discount: lineDiscount,
      tax_rate: taxRate,
      gross: roundInt(it.gross ?? 0),
      net: roundInt(it.net ?? 0),
      tax,
      line_total: total,
      total,
      user: user?._id || user?.id,
      user_id: user?._id || user?.id,
    });
  }

  if (docs.length === 0) return [];
  return SaleItem.insertMany(docs, { ordered: true, session });
}

// Catalogo (productos + gastos)
router.get("/catalog", authMiddleware, async (req, res) => {
  try {
    const products = await Product.find({ active: { $ne: false } }).sort({ name: 1 });
    const expenses = await Expense.find({ active: { $ne: false } }).sort({ name: 1 });

    return res.json({
      ok: true,
      products: products.map((p) => p.toJSON()),
      expenses: expenses.map((e) => e.toJSON()),
      items: products.map((p) => p.toJSON()),
    });
  } catch (error) {
    console.error("Error al obtener catálogo:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener catálogo" });
  }
});

// Crea una venta (descuenta stock dentro de la misma transacción)
router.post("/", authMiddleware, async (req, res) => {
  try {
    const payload = await buildSalePayload(req.body);

    if (!payload.items || payload.items.length === 0) {
      return res.status(400).json({ ok: false, error: "Debe incluir items" });
    }

    const productIds = collectUniqueProductIds(payload.items);
    const recipeMap = await buildRecipeMap(productIds);

    // Incluye ingredientes en el mapa para validar y descontar
    const allIds = new Set(productIds);
    for (const r of recipeMap.values()) {
      const items = Array.isArray(r.items) ? r.items : [];
      for (const ing of items) {
        const ingredientProductId = ing.product_id || ing.productId || ing.product;
        if (ingredientProductId) allIds.add(String(ingredientProductId));
      }
    }

    const productMap = await buildProductsMap(Array.from(allIds));
    await validateRecipeStock(productMap, recipeMap, payload.items);

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const saleDoc = {
        status: payload.status,
        subtotal: payload.subtotal,
        discount_total: payload.discount_total,
        tax_total: payload.tax_total,
        total: payload.total,
        paid: payload.paid,
        change: payload.change,
        note: payload.note || null,
        client: payload.client || null,
        user: req.user?._id || req.user?.id,
        user_id: req.user?._id || req.user?.id,
      };

      const createdSaleArr = await Sale.create([saleDoc], { session });
      const sale = createdSaleArr[0];

      const createdItems = await createItemsForSale(sale, payload.items, req.user, session, productMap);
      const createdPayments = await createPaymentsForSale(sale, payload.payments, req.user, session);

      await decrementStockForSale(productMap, recipeMap, payload.items, session);

      await session.commitTransaction();
      session.endSession();

      return res.json({
        ok: true,
        sale: sale.toJSON(),
        items: createdItems.map((it) => it.toJSON()),
        payments: createdPayments.map((p) => p.toJSON()),
      });
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      throw err;
    }
  } catch (error) {
    console.error("Error al crear venta:", error.message);
    const code = error.status ? Number(error.status) : 500;
    return res.status(code).json({
      ok: false,
      error: error.message || "Error al crear venta",
      detail: error.message,
    });
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

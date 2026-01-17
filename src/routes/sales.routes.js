const express = require("express");
const mongoose = require("mongoose");
const { authMiddleware } = require("./auth.routes");
const Sale = require("../models/Sale");
const SaleItem = require("../models/SaleItem");
const Payment = require("../models/Payment");
const SaleReturn = require("../models/SaleReturn");
const Product = require("../models/Product");
const ProductRecipe = require("../models/ProductRecipe");
const InventoryMove = require("../models/InventoryMove");
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

// Asigna usuario usando los campos disponibles
function attachUserRef(doc, user, Model) {
  const userObjId = user?._id || user?.id;
  if (!userObjId) return;

  if (hasSchemaPath(Model, "user")) doc.user = userObjId;
  if (hasSchemaPath(Model, "user_id")) doc.user_id = userObjId;

  if (!hasSchemaPath(Model, "user") && !hasSchemaPath(Model, "user_id")) {
    doc.user = userObjId;
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
        throw new Error(
          `Stock insuficiente para ${product.name || "producto"} (${stock})`
        );
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
        throw new Error(
          `Stock insuficiente de insumo ${ing.name || "ingrediente"} (${have})`
        );
      }
    }
  }
}

// Descuenta stock inmediatamente por venta
async function decrementStockForSale(productMap, recipeMap, items) {
  const list = ensureArray(items);
  const dec = new Map();

  for (const it of list) {
    const productId = String(it.productId || it.product_id || it.product || "");
    const qty = toInt(it.qty, 1);
    if (!productId || qty <= 0) continue;

    const product = productMap.get(productId);
    if (!product) {
      throw new Error("Producto no encontrado para descontar stock");
    }

    const recipes = recipeMap.get(productId) || [];

    // Sin receta: descuenta el producto
    if (recipes.length === 0) {
      const prev = toNumber(dec.get(productId), 0);
      dec.set(productId, prev + qty);
      continue;
    }

    // Con receta: descuenta ingredientes
    for (const r of recipes) {
      const ingId = String(r.ingredient || "");
      if (!ingId) continue;

      const need = toNumber(r.qty, 0) * qty;
      if (need <= 0) continue;

      const prev = toNumber(dec.get(ingId), 0);
      dec.set(ingId, prev + need);
    }
  }

  const applied = [];
  const keys = Array.from(dec.keys()).sort();

  try {
    for (const id of keys) {
      const need = roundInt(dec.get(id));
      if (need <= 0) continue;

      const r = await Product.updateOne(
        { _id: id, stock: { $gte: need } },
        { $inc: { stock: -need } }
      );

      const modified = r && (r.modifiedCount ?? r.nModified ?? 0);
      if (!modified) {
        const name = productMap.get(String(id))?.name;
        throw new Error(`Stock insuficiente para ${name || "producto"}`);
      }

      applied.push({ id, qty: need });
    }

    return applied;
  } catch (err) {
    // Rollback manual
    for (const a of applied) {
      try {
        await Product.updateOne({ _id: a.id }, { $inc: { stock: a.qty } });
      } catch (e) {
        console.error("Rollback stock falló:", e.message);
      }
    }
    throw err;
  }
}

// Rollback de stock si falla la venta después del descuento
async function rollbackStock(applied) {
  const list = Array.isArray(applied) ? applied : [];
  for (const a of list) {
    try {
      await Product.updateOne({ _id: a.id }, { $inc: { stock: a.qty } });
    } catch (e) {
      console.error("Rollback stock falló:", e.message);
    }
  }
}


// Convierte a número seguro (alias local)
function toNum(v, def = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return n;
}

function getSaleInfo(sale) {
  const saleObjId = sale?._id || sale?.id;
  const saleStr = String(sale?.id || saleObjId || "");
  return { saleObjId, saleStr };
}

function itemBelongsToSale(item, saleInfo) {
  const sObj = saleInfo.saleObjId;
  const sStr = saleInfo.saleStr;

  if (item && item.sale != null && String(item.sale) === String(sObj)) return true;
  if (item && item.sale != null && String(item.sale) === String(sStr)) return true;
  if (item && item.sale_id != null && String(item.sale_id) === String(sObj)) return true;
  if (item && item.sale_id != null && String(item.sale_id) === String(sStr)) return true;

  return false;
}

function getItemProductId(item) {
  return item?.product || item?.product_id || item?.productId || null;
}

// Calcula el total unitario para reembolso basado en el ítem
function computeReturnUnitTotal(item) {
  const soldQty = Math.max(1, roundInt(item?.qty || 1));
  const unitPrice = roundInt(item?.unit_price ?? item?.unitPrice ?? 0);
  const lineDiscount = roundInt(item?.line_discount ?? item?.lineDiscount ?? 0);

  const unitDisc = lineDiscount > 0 ? Math.floor(lineDiscount / soldQty) : 0;
  const unitBase = Math.max(0, unitPrice - unitDisc);

  let unitTax = 0;
  const taxRate = toNum(item?.tax_rate ?? item?.taxRate ?? 0, 0);
  if (taxRate > 0) {
    unitTax = Math.round((unitBase * taxRate) / 100);
  } else {
    const lineTax = roundInt(item?.tax ?? 0);
    unitTax = lineTax > 0 ? Math.round(lineTax / soldQty) : 0;
  }

  return Math.max(0, roundInt(unitBase + unitTax));
}

async function sumReturnedQtyForItem(session, saleObjId, saleItemObjId) {
  const agg = await SaleReturn.aggregate([
    {
      $match: {
        sale: saleObjId,
        sale_item: saleItemObjId,
      },
    },
    {
      $group: {
        _id: null,
        qty: { $sum: "$qty" },
      },
    },
  ]).session(session);

  const v = agg && agg[0] ? Number(agg[0].qty || 0) : 0;
  return Number.isFinite(v) ? v : 0;
}

async function createInventoryMoveForReturn(session, { productId, qty, note, user, saleId }) {
  const moveDoc = {
    product: productId,
    qty: qty,
    note: note || "Devolución de venta",
    user: user ? user.id : null,
    type: "RETURN",
    sourceRef: saleId || null,
    location: null,
    supplierId: null,
    supplierName: null,
    invoiceNumber: null,
    unitCost: null,
    discount: null,
    tax: null,
    lot: null,
    expiryDate: null,
  };

  const move = new InventoryMove(moveDoc);
  await move.save({ session });
  return move;
}

async function applyReturnsAndRestock(session, { sale, lines, note, user }) {
  const saleInfo = getSaleInfo(sale);

  if (sale.status === "VOIDED") {
    throw new Error("La venta ya está anulada");
  }

  const created = [];

  for (const ln of Array.isArray(lines) ? lines : []) {
    const saleItemId = String(ln.sale_item_id || ln.sale_item || ln.saleItemId || "");
    const qty = Number(ln.qty || 0);

    if (!saleItemId) {
      throw new Error("sale_item_id requerido");
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error("Cantidad inválida");
    }

    const item = await SaleItem.findById(saleItemId).session(session);
    if (!item) {
      throw new Error("Item no encontrado");
    }

    if (!itemBelongsToSale(item, saleInfo)) {
      throw new Error("El item no pertenece a la venta");
    }

    const soldQty = Math.max(0, toNum(item.qty, 0));
    const returnedBefore = await sumReturnedQtyForItem(session, saleInfo.saleObjId, item._id);
    const remaining = Math.max(0, soldQty - returnedBefore);

    if (qty > remaining) {
      throw new Error("La cantidad a devolver supera lo vendido");
    }

    const unitTotal = computeReturnUnitTotal(item);
    const refundAmount = roundInt(unitTotal * qty);

    const r = new SaleReturn({
      sale: saleInfo.saleObjId,
      sale_item: item._id,
      qty: qty,
      refund_amount: refundAmount,
      note: note ?? null,
    });

    await r.save({ session });
    created.append(r);

    const productId = getItemProductId(item);
    if (!productId) {
      throw new Error("No se pudo determinar el producto del item");
    }

    const product = await Product.findById(productId).session(session);
    if (!product) {
      throw new Error("Producto no encontrado para reingresar stock");
    }

    const prevStock = Number(product.stock || 0);
    product.stock = prevStock + Number(qty);
    await product.save({ session });

    await createInventoryMoveForReturn(session, {
      productId: product._id,
      qty: Number(qty),
      note: note || `Devolución venta ${saleInfo.saleStr}`,
      user,
      saleId: saleInfo.saleStr,
    });
  }

  if (created.length) {
    // Actualiza estado de la venta según lo devuelto
    const allItems = await SaleItem.find({
      $or: [
        { sale: saleInfo.saleObjId },
        { sale_id: saleInfo.saleStr },
        { sale: saleInfo.saleStr },
      ],
    }).session(session);

    const agg = await SaleReturn.aggregate([
      { $match: { sale: saleInfo.saleObjId } },
      { $group: { _id: "$sale_item", qty: { $sum: "$qty" } } },
    ]).session(session);

    const byItem = new Map();
    for (const row of agg || []) {
      byItem.set(String(row._id), Number(row.qty || 0));
    }

    let fully = true;
    for (const it of allItems || []) {
      const sold = Number(it.qty || 0);
      const ret = Number(byItem.get(String(it._id)) || 0);
      if (sold > 0 && ret < sold) {
        fully = false;
        break;
      }
    }

    sale.status = fully ? "REFUNDED" : "PARTIAL_REFUND";
    await sale.save({ session });
  }

  return created;
}



// Obtiene info de ids de venta para comparaciones
function saleIdInfoFromSale(sale) {
  const saleObjId = sale?._id || sale?.id;
  const saleStr = String(sale?.id || saleObjId || "");
  return { saleObjId, saleStr };
}

// Verifica si un item pertenece a una venta
function saleItemBelongsToSale(item, saleInfo) {
  const saleObjId = saleInfo?.saleObjId;
  const saleStr = saleInfo?.saleStr;

  const itemSale = item?.sale;
  const itemSaleId = item?.sale_id;

  if (itemSale != null && String(itemSale) === String(saleObjId)) return true;
  if (itemSale != null && String(itemSale) === String(saleStr)) return true;
  if (itemSaleId != null && String(itemSaleId) === String(saleObjId)) return true;
  if (itemSaleId != null && String(itemSaleId) === String(saleStr)) return true;

  return false;
}

// Extrae el id de producto desde un SaleItem
function getProductIdFromSaleItem(item) {
  return item?.product || item?.product_id || null;
}

// Calcula el monto de reembolso para una cantidad devuelta (producto final)
function computeRefundAmountForReturn(item, returnQty) {
  const soldQty = Math.max(1, toNumber(item?.qty, 1));

  const unitPrice = roundInt(item?.unit_price ?? 0);
  const lineDiscount = roundInt(item?.line_discount ?? 0);
  const taxRate = toNumber(item?.tax_rate ?? 0, 0);
  const lineTax = roundInt(item?.tax ?? 0);

  const unitDisc = soldQty > 0 ? Math.floor(lineDiscount / soldQty) : 0;
  const unitBase = Math.max(0, unitPrice - unitDisc);

  let unitTax = 0;
  if (taxRate > 0) {
    unitTax = Math.round((unitBase * taxRate) / 100);
  } else if (soldQty > 0 && lineTax > 0) {
    unitTax = Math.round(lineTax / soldQty);
  }

  const unitTotal = roundInt(unitBase + unitTax);
  return roundInt(unitTotal * Math.max(0, toInt(returnQty, 0)));
}

// Crea movimiento de inventario consistente con inventory.routes
function buildReturnMoveDoc(productId, qty, note, user, sourceRef, location) {
  return {
    product: productId,
    qty,
    note: note || "Devolución de venta",
    user: user ? user.id : null,
    type: "RETURN",
    sourceRef: sourceRef || null,
    location: location || null,
    supplierId: null,
    supplierName: null,
    invoiceNumber: null,
    unitCost: null,
    discount: null,
    tax: null,
    lot: null,
    expiryDate: null,
  };
}

// Aplica devoluciones (batch) dentro de una transacción y reingresa stock
async function applyReturnsBatchInTxn({ sale, lines, note, user, session }) {
  const saleInfo = saleIdInfoFromSale(sale);
  const saleObjId = saleInfo.saleObjId;

  const safeLines = ensureArray(lines)
    .map((l) => {
      const saleItemId = l.sale_item_id || l.sale_item || l.saleItemId || l.saleItem || null;
      const qty = toInt(l.qty, 0);
      return { saleItemId: saleItemId ? String(saleItemId) : null, qty };
    })
    .filter((l) => l.saleItemId && l.qty > 0);

  if (!safeLines.length) {
    throw new Error("No hay líneas válidas para devolver");
  }

  const saleItemIds = safeLines.map((l) => l.saleItemId);
  const saleItems = await SaleItem.find({ _id: { $in: saleItemIds } }).session(session);
  const saleItemMap = new Map();
  for (const it of saleItems) saleItemMap.set(String(it._id), it);

  // Valida pertenencia de ítems a la venta
  for (const l of safeLines) {
    const it = saleItemMap.get(String(l.saleItemId));
    if (!it) throw new Error("Item no encontrado para devolución");
    if (!saleItemBelongsToSale(it, saleInfo)) {
      throw new Error("El item no pertenece a la venta");
    }
  }

  // Retornos existentes por item
  const agg = await SaleReturn.aggregate([
    { $match: { sale: saleObjId, sale_item: { $in: saleItems.map((x) => x._id) } } },
    { $group: { _id: "$sale_item", qty: { $sum: "$qty" } } },
  ]).session(session);

  const returnedMap = new Map();
  for (const a of agg) returnedMap.set(String(a._id), toNumber(a.qty, 0));

  const created = [];
  let refundTotal = 0;

  const fixedLocation = process.env.STOCK_FIXED_LOCATION || process.env.DEFAULT_STOCK_LOCATION || null;

  for (const l of safeLines) {
    const it = saleItemMap.get(String(l.saleItemId));
    const soldQty = toNumber(it?.qty, 0);
    const already = toNumber(returnedMap.get(String(it._id)), 0);
    const remaining = Math.max(0, soldQty - already);

    if (remaining <= 0) {
      throw new Error("El item ya fue devuelto completamente");
    }

    if (l.qty > remaining) {
      throw new Error(`Cantidad a devolver supera el disponible (${remaining})`);
    }

    const refund_amount = computeRefundAmountForReturn(it, l.qty);

    const retDoc = new SaleReturn({
      sale: saleObjId,
      sale_item: it._id,
      qty: l.qty,
      refund_amount,
      note: note ?? null,
    });

    await retDoc.save({ session });
    created.append(retDoc);

    refundTotal += refund_amount;

    // Reingresa stock del producto final
    const productId = getProductIdFromSaleItem(it);
    if (!productId) {
      throw new Error("No se pudo determinar el producto del item");
    }

    const product = await Product.findById(productId).session(session);
    if (!product) {
      throw new Error("Producto no encontrado para reingresar stock");
    }

    const currStock = toNumber(product.stock, 0);
    product.stock = currStock + l.qty;
    await product.save({ session });

    const moveDoc = buildReturnMoveDoc(
      product._id,
      l.qty,
      note || `Devolución venta ${saleInfo.saleStr}`,
      user,
      String(saleObjId),
      fixedLocation
    );

    const invMove = new InventoryMove(moveDoc);
    await invMove.save({ session });

    // Actualiza contador local
    returnedMap.set(String(it._id), already + l.qty);
  }

  // Actualiza estado de la venta según devoluciones acumuladas
  const allItems = await SaleItem.find({
    $or: [{ sale: saleObjId }, { sale_id: saleInfo.saleStr }],
  }).session(session);

  let allReturned = allItems.length > 0;
  for (const it of allItems) {
    const soldQty = toNumber(it?.qty, 0);
    const returnedQty = toNumber(returnedMap.get(String(it._id)), 0);
    if (returnedQty < soldQty) {
      allReturned = false;
      break;
    }
  }

  sale.status = allReturned ? "REFUNDED" : "PARTIAL_REFUND";
  await sale.save({ session });

  return { created, refundTotal };
}

// Crea pagos asociados a una venta
async function createPaymentsForSale(sale, payments, user) {
  const docs = [];
  for (const p of payments || []) {
    const doc = {
      method: p.method,
      provider: p.provider || null,
      reference: p.reference || null,
      amount: roundInt(p.amount),
    };

    attachSaleRef(doc, sale, Payment);
    attachUserRef(doc, user, Payment);
    docs.push(doc);
  }
  if (docs.length === 0) return [];

  const created = await Payment.insertMany(docs, { ordered: true });
  return created;
}

// Crea items asociados a una venta
async function createItemsForSale(sale, items, user, productMap) {
  const docs = [];
  for (const it of items || []) {
    // Mapea el item a los campos requeridos por el modelo actual
    const productRaw = it.productId || it.product_id || it.product;
    if (!productRaw) {
      throw new Error("Producto requerido en item");
    }

    const qty = Number(it.qty || 1);
    const unitPrice = roundInt(it.unit_price ?? it.unitPrice ?? 0);
    const lineDiscount = roundInt(it.line_discount ?? it.lineDiscount ?? 0);
    const taxRate = Number(it.tax_rate ?? it.taxRate ?? 0);
    const tax = roundInt(it.tax ?? 0);

    const rawTotal = it.total ?? it.line_total ?? it.lineTotal;
    const computedTotal = roundInt(qty * unitPrice - lineDiscount + tax);
    const total = roundInt(rawTotal ?? computedTotal);

    const doc = {
      qty,
      unit_price: unitPrice,
      line_discount: lineDiscount,
      tax_rate: taxRate,
      gross: roundInt(it.gross ?? 0),
      net: roundInt(it.net ?? 0),
      tax,
      total,
    };

    if (hasSchemaPath(SaleItem, "product")) doc.product = productRaw;
    if (hasSchemaPath(SaleItem, "product_id")) doc.product_id = productRaw;

    let nameSnapshot = String(
      it.name_snapshot ?? it.name ?? it.productName ?? ""
    ).trim();

    if (!nameSnapshot) {
      const p = productMap && productMap.get(String(productRaw));
      if (p && p.name) nameSnapshot = String(p.name).trim();
    }

    if (hasSchemaPath(SaleItem, "name_snapshot")) doc.name_snapshot = nameSnapshot;
    if (hasSchemaPath(SaleItem, "name")) doc.name = nameSnapshot;

    if (hasSchemaPath(SaleItem, "name_snapshot") && !nameSnapshot) {
      throw new Error("Nombre requerido en item (name_snapshot)");
    }

    if (hasSchemaPath(SaleItem, "line_total")) doc.line_total = total;

    attachSaleRef(doc, sale, SaleItem);
    attachUserRef(doc, user, SaleItem);
    docs.push(doc);
  }

  if (docs.length === 0) return [];

  const created = await SaleItem.insertMany(docs, { ordered: true });
  return created;
}

// Obtiene catálogo de ventas
router.get("/catalog", authMiddleware, async (req, res) => {
  try {
    const products = await Product.find({ active: { $ne: false } }).sort({
      name: 1,
    });
    const expenses = await Expense.find({ active: { $ne: false } }).sort({
      name: 1,
    });

    return res.json({
      ok: true,
      products: products.map((p) => p.toJSON()),
      expenses: expenses.map((e) => e.toJSON()),
      items: products.map((p) => p.toJSON()),
    });
  } catch (error) {
    console.error("Error al obtener catálogo:", error.message);
    return res
      .status(500)
      .json({ ok: false, error: "Error al obtener catálogo" });
  }
});

// Obtiene catálogo con recetas para validar stock por ingredientes
async function withRecipesHandler(req, res) {
  try {
    const products = await Product.find({ active: { $ne: false } }).sort({
      name: 1,
    });
    const expenses = await Expense.find({ active: { $ne: false } }).sort({
      name: 1,
    });

    const productIds = products.map((p) => p._id);
    const recipes = await ProductRecipe.find({ product: { $in: productIds } });

    return res.json({
      ok: true,
      products: products.map((p) => p.toJSON()),
      recipes: recipes.map((r) => r.toJSON()),
      expenses: expenses.map((e) => e.toJSON()),
      items: products.map((p) => p.toJSON()),
    });
  } catch (error) {
    console.error("Error al obtener catálogo con recetas:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Error al obtener catálogo con recetas",
    });
  }
}

router.get("/with-recipes", authMiddleware, withRecipesHandler);
router.post("/with-recipes", authMiddleware, withRecipesHandler);

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
    return res
      .status(500)
      .json({ ok: false, error: "Error en paymentsSummary" });
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
    return res
      .status(500)
      .json({ ok: false, error: "Error al listar ventas" });
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
      $or: [
        { sale_id: saleIdStr },
        { sale_id: saleIdObj },
        { sale: saleIdObj },
        { sale: saleIdStr },
      ],
    }).sort({ createdAt: 1 });

    const payments = await Payment.find({
      $or: [
        { sale_id: saleIdStr },
        { sale_id: saleIdObj },
        { sale: saleIdObj },
        { sale: saleIdStr },
      ],
    }).sort({ createdAt: 1 });

    const returns = await SaleReturn.find({
      $or: [
        { sale: saleIdObj },
        { sale: saleIdStr },
        { sale_id: saleIdStr },
        { sale_id: saleIdObj },
      ],
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
    return res
      .status(500)
      .json({ ok: false, error: "Error al obtener venta" });
  }
});

// Crea una venta
router.post("/", authMiddleware, async (req, res) => {
  let applied = [];

  try {
    const payload = req.body || {};

    if (!payload.items || payload.items.length === 0) {
      return res.status(400).json({ ok: false, error: "Debe incluir items" });
    }

    const productIds = collectUniqueProductIds(payload.items);
    const productMap = await buildProductsMap(productIds);
    const recipeMap = await buildRecipeMap(productIds);

    await validateRecipeStock(productMap, recipeMap, payload.items);

    // Descuenta stock antes de crear la venta
    applied = await decrementStockForSale(productMap, recipeMap, payload.items);

    try {
      const status = String(payload.status || "COMPLETED").toUpperCase();

      const saleDoc = {
        status,
        subtotal: payload.subtotal,
        discount_total: payload.discount_total,
        tax_total: payload.tax_total,
        total: payload.total,
        notes: payload.notes ?? payload.note ?? null,
        client:
          payload.client ?? payload.customer_name ?? payload.customerName ?? null,
      };

      attachUserRef(saleDoc, req.user, Sale);

      const sale = await Sale.create(saleDoc);

      await createItemsForSale(sale, payload.items, req.user, productMap);
      await createPaymentsForSale(sale, payload.payments || [], req.user);

      return res.json({ ok: true, sale: sale.toJSON() });
    } catch (innerErr) {
      await rollbackStock(applied);
      throw innerErr;
    }
  } catch (error) {
    console.error("Error al crear venta:", error.message);
    return res
      .status(500)
      .json({ ok: false, error: "Error al crear venta", detail: error.message });
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
      return res
        .status(400)
        .json({ ok: false, error: "La venta ya está anulada" });
    }

    sale.status = "VOIDED";
    await sale.save();

    return res.json({ ok: true, sale: sale.toJSON() });
  } catch (error) {
    console.error("Error al anular venta:", error.message);
    return res
      .status(500)
      .json({ ok: false, error: "Error al anular venta" });
  }
});


// Crea devoluciones (batch) y reingresa stock al producto final
router.post("/returns", authMiddleware, async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const sale_id = String(req.body?.sale_id || req.body?.saleId || "");
    const lines = Array.isArray(req.body?.items) ? req.body.items : [];
    const note = req.body?.note ?? null;

    if (!sale_id) {
      return res.status(400).json({ ok: false, error: "sale_id requerido" });
    }
    if (!lines.length) {
      return res.status(400).json({ ok: false, error: "items requeridos" });
    }

    let saleOut = null;
    let createdReturns = [];

    await session.withTransaction(async () => {
      const sale = await Sale.findById(sale_id).session(session);
      if (!sale) {
        throw new Error("Venta no encontrada");
      }

      const out = await applyReturnsBatchInTxn({ sale, lines, note, user: req.user, session });
      createdReturns = out.created;

      saleOut = sale;
    });

    return res.json({
      ok: true,
      sale: saleOut ? saleOut.toJSON() : null,
      returns: createdReturns.map((r) => r.toJSON()),
    });
  } catch (error) {
    const msg = String(error?.message || "Error al crear devolución");
    console.error("Error al crear devolución batch:", msg);
    return res.status(400).json({ ok: false, error: msg });
  } finally {
    session.endSession();
  }
});

// Crea devolución parcial de un item de venta
router.post("/:id/returns", authMiddleware, async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const saleId = String(req.params.id || "").trim();
    const sale_item = req.body?.sale_item || req.body?.sale_item_id || req.body?.saleItemId;
    const qty = toInt(req.body?.qty, 0);
    const note = req.body?.note ?? null;

    if (!sale_item) {
      return res.status(400).json({ ok: false, error: "sale_item requerido" });
    }
    if (!(qty > 0)) {
      return res.status(400).json({ ok: false, error: "Cantidad inválida" });
    }

    let createdItem = null;
    let updatedSale = null;

    await session.withTransaction(async () => {
      const sale = await Sale.findById(saleId).session(session);
      if (!sale) {
        throw new Error("Venta no encontrada");
      }

      if (sale.status === "VOIDED") {
        throw new Error("La venta está anulada");
      }

      if (sale.status === "REFUNDED") {
        throw new Error("La venta ya está reembolsada");
      }

      const lines = [{ sale_item_id: String(sale_item), qty }];
      const r = await applyReturnsBatchInTxn({ sale, lines, note, user: req.user, session });

      const first = (r?.created || [])[0] || null;
      createdItem = first;
      updatedSale = sale;
    });

    return res.json({
      ok: true,
      sale: updatedSale ? updatedSale.toJSON() : null,
      item: createdItem ? createdItem.toJSON() : null,
    });
  } catch (error) {
    console.error("Error al crear devolución:", error.message);
    return res.status(400).json({ ok: false, error: error.message || "Error" });
  } finally {
    try {
      session.endSession();
    } catch (e) {
      // no-op
    }
  }
});

module.exports = {
  salesRouter: router,
};

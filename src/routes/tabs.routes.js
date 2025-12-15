const express = require("express");
const { authMiddleware } = require("./auth.routes");
const Tab = require("../models/Tab");
const TabItem = require("../models/TabItem");
const StockReservation = require("../models/StockReservation");
const Product = require("../models/Product");

// Crea el router para agrupar las rutas de mesas
const router = express.Router();

// Calcula totales por línea de ítem
function calcLineTotals(unit_price, qty, line_discount, tax_rate) {
  const gross = unit_price * qty;
  const discount = Math.max(0, Number(line_discount || 0));
  const base = Math.max(0, gross - discount);
  const rate = typeof tax_rate === "number" ? tax_rate : null;
  const tax = rate !== null ? Math.round((base * rate) / 100) : 0;
  const total = base + tax;
  return { gross, discount, base, tax, total };
}

// Obtiene una reserva activa para un producto y mesa
async function getActiveReservation(tabId, productId) {
  const resv = await StockReservation.findOne({
    tab: tabId,
    product: productId,
    consumed: false,
  });
  return resv;
}

// Aumenta la reserva de stock para un producto en una mesa
async function increaseReservation(tabId, productId, qtyDelta, userId) {
  if (!qtyDelta || qtyDelta <= 0) return null;

  const existing = await getActiveReservation(tabId, productId);
  if (existing) {
    existing.qty = existing.qty + qtyDelta;
    await existing.save();
    return existing;
  }

  const resv = await StockReservation.create({
    product: productId,
    tab: tabId,
    qty: qtyDelta,
    reserved_by: userId || null,
    consumed: false,
    consumed_at: null,
    sourceRef: null,
    expires_at: null,
  });

  return resv;
}

// Disminuye o elimina la reserva de stock para un producto en una mesa
async function decreaseReservation(tabId, productId, qtyDelta) {
  if (!qtyDelta || qtyDelta <= 0) return null;

  const existing = await getActiveReservation(tabId, productId);
  if (!existing) return null;

  const nextQty = existing.qty - qtyDelta;

  if (nextQty > 0) {
    existing.qty = nextQty;
    await existing.save();
    return existing;
  }

  await StockReservation.deleteOne({ _id: existing._id });
  return null;
}

// Calcula los totales de una mesa a partir de sus ítems
function computeTabTotals(items) {
  let subtotal = 0;
  let discount_total = 0;
  let tax_total = 0;
  let total = 0;
  let count = 0;

  for (const it of items) {
    const qty = Number(it.qty || 0);
    const unit_price = Number(it.unit_price || 0);
    const line_discount = Number(it.line_discount || 0);
    const tax_amount = Number(it.tax_amount || 0);
    const line_total = Number(it.line_total || 0);

    const gross = unit_price * qty;
    subtotal += Math.max(0, gross - line_discount);
    discount_total += line_discount;
    tax_total += tax_amount;
    total += line_total;
    count += qty;
  }

  return {
    subtotal,
    discount_total,
    tax_total,
    total,
    items_count: count,
  };
}

// Lista las mesas con filtros básicos
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { status = "OPEN", q = "", limit = "100", offset = "0" } = req.query;

    const filter = {};
    const text = String(q || "").trim();

    if (status && status.toUpperCase() !== "ALL") {
      filter.status = status.toUpperCase();
    }

    if (text) {
      const regex = new RegExp(text, "i");
      filter.name = regex;
    }

    const lim = Math.max(1, Math.min(500, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);

    const tabs = await Tab.find(filter)
      .populate("user", "username name role")
      .sort({ opened_at: -1, _id: -1 })
      .skip(off)
      .limit(lim);

    const items = tabs.map((t) => t.toJSON());

    return res.json({
      ok: true,
      items,
      total: items.length,
    });
  } catch (error) {
    console.error("Error al listar mesas:", error.message);
    return res.status(500).json({ ok: false, error: "Error al listar mesas" });
  }
});

// Crea una nueva mesa
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { name, notes } = req.body || {};

    const safeName = String(name || "").trim() || "Mesa";

    const tab = await Tab.create({
      name: safeName,
      status: "OPEN",
      user: req.user ? req.user.id : null,
      notes: notes || null,
      opened_at: new Date(),
      closed_at: null,
    });

    const full = await Tab.findById(tab._id).populate("user", "username name role");

    return res.status(201).json({
      ok: true,
      tab: full.toJSON(),
    });
  } catch (error) {
    console.error("Error al crear mesa:", error.message);
    return res.status(500).json({ ok: false, error: "Error al crear mesa" });
  }
});

// Resumen de reservas activas (consumed=false) por producto en mesas OPEN
router.get("/reservations/summary", authMiddleware, async (req, res) => {
  try {
    const { status = "OPEN" } = req.query;

    const tabCollection = Tab.collection && Tab.collection.name ? Tab.collection.name : "tabs";
    const desiredStatus = String(status || "OPEN").toUpperCase();

    const pipeline = [
      { $match: { consumed: false } },
      {
        $lookup: {
          from: tabCollection,
          localField: "tab",
          foreignField: "_id",
          as: "tabDoc",
        },
      },
      { $unwind: "$tabDoc" },
    ];

    if (desiredStatus && desiredStatus !== "ALL") {
      pipeline.push({ $match: { "tabDoc.status": desiredStatus } });
    }

    pipeline.push(
      {
        $group: {
          _id: "$product",
          reserved_qty: { $sum: "$qty" },
        },
      },
      { $sort: { reserved_qty: -1 } }
    );

    const rows = await StockReservation.aggregate(pipeline);

    const items = (rows || [])
      .filter((r) => r && r._id)
      .map((r) => ({
        product_id: String(r._id),
        reserved_qty: Number(r.reserved_qty || 0),
      }));

    return res.json({
      ok: true,
      status: desiredStatus,
      items,
      total: items.length,
    });
  } catch (error) {
    console.error("Error al resumir reservas activas:", error.message);
    return res.status(500).json({ ok: false, error: "Error al resumir reservas activas" });
  }
});

// Obtiene el detalle de una mesa con sus ítems
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const tab = await Tab.findById(id).populate("user", "username name role");

    if (!tab) {
      return res.status(404).json({ ok: false, error: "Mesa no encontrada" });
    }

    const items = await TabItem.find({ tab: tab._id })
      .populate("product")
      .sort({ added_at: 1, _id: 1 });

    const totals = computeTabTotals(items);

    return res.json({
      ok: true,
      tab: tab.toJSON(),
      items: items.map((i) => i.toJSON()),
      totals,
    });
  } catch (error) {
    console.error("Error al obtener mesa:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener mesa" });
  }
});

// Renombra una mesa
router.put("/:id/rename", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body || {};

    const tab = await Tab.findById(id);

    if (!tab) {
      return res.status(404).json({ ok: false, error: "Mesa no encontrada" });
    }

    const safeName = String(name || "").trim();
    if (!safeName) {
      return res.status(400).json({ ok: false, error: "Nombre inválido" });
    }

    tab.name = safeName;
    await tab.save();

    return res.json({
      ok: true,
      tab: tab.toJSON(),
    });
  } catch (error) {
    console.error("Error al renombrar mesa:", error.message);
    return res.status(500).json({ ok: false, error: "Error al renombrar mesa" });
  }
});

// Actualiza las notas de una mesa
router.put("/:id/note", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body || {};

    const tab = await Tab.findById(id);

    if (!tab) {
      return res.status(404).json({ ok: false, error: "Mesa no encontrada" });
    }

    tab.notes = notes || null;
    await tab.save();

    return res.json({
      ok: true,
      tab: tab.toJSON(),
    });
  } catch (error) {
    console.error("Error al actualizar nota de mesa:", error.message);
    return res
      .status(500)
      .json({ ok: false, error: "Error al actualizar nota de mesa" });
  }
});

// Agrega un ítem a una mesa y crea o aumenta la reserva de stock
router.post("/:id/items", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { productId, qty, unit_price, line_discount, tax_rate } = req.body || {};

    const tab = await Tab.findById(id);

    if (!tab) {
      return res.status(404).json({ ok: false, error: "Mesa no encontrada" });
    }

    if (tab.status !== "OPEN") {
      return res.status(400).json({ ok: false, error: "La mesa no está abierta" });
    }

    const product = await Product.findById(productId);

    if (!product || !product.is_active) {
      return res
        .status(404)
        .json({ ok: false, error: "Producto no encontrado o inactivo" });
    }

    const qtyN = Number(qty);
    if (!Number.isFinite(qtyN) || qtyN <= 0 || Math.round(qtyN) !== qtyN) {
      return res.status(400).json({ ok: false, error: "Cantidad inválida" });
    }

    const priceN =
      unit_price !== undefined && unit_price !== null
        ? Number(unit_price)
        : Number(product.price || 0);

    if (!Number.isFinite(priceN) || priceN < 0) {
      return res.status(400).json({ ok: false, error: "Precio inválido" });
    }

    const discN =
      line_discount !== undefined && line_discount !== null
        ? Number(line_discount)
        : 0;

    let taxRateN = null;
    if (tax_rate !== undefined && tax_rate !== null) {
      const tr = Number(tax_rate);
      if (!Number.isNaN(tr)) taxRateN = tr;
    }

    const { discount, tax, total } = calcLineTotals(
      priceN,
      qtyN,
      discN,
      taxRateN
    );

    await increaseReservation(tab._id, product._id, qtyN, req.user && req.user.id);

    const item = await TabItem.create({
      tab: tab._id,
      product: product._id,
      qty: qtyN,
      unit_price: priceN,
      line_discount: discount,
      tax_rate: taxRateN,
      tax_amount: tax,
      line_total: total,
      name_snapshot: product.name,
      category_snapshot: product.category || null,
      added_at: new Date(),
    });

    const fullItem = await TabItem.findById(item._id).populate("product");

    return res.status(201).json({
      ok: true,
      item: fullItem.toJSON(),
    });
  } catch (error) {
    console.error("Error al agregar ítem a mesa:", error.message);
    return res.status(500).json({ ok: false, error: "Error al agregar ítem a mesa" });
  }
});

// Actualiza un ítem de mesa y ajusta la reserva de stock
router.put("/items/:itemId", authMiddleware, async (req, res) => {
  try {
    const { itemId } = req.params;
    const { qty, unit_price, line_discount, tax_rate } = req.body || {};

    const item = await TabItem.findById(itemId).populate("product");

    if (!item) {
      return res.status(404).json({ ok: false, error: "Ítem no encontrado" });
    }

    const tab = await Tab.findById(item.tab);

    if (!tab) {
      return res.status(404).json({ ok: false, error: "Mesa no encontrada" });
    }

    if (tab.status !== "OPEN") {
      return res.status(400).json({ ok: false, error: "La mesa no está abierta" });
    }

    const originalQty = item.qty;

    let nextQty = originalQty;
    if (qty !== undefined) {
      const qN = Number(qty);
      if (!Number.isFinite(qN) || qN <= 0 || Math.round(qN) !== qN) {
        return res.status(400).json({ ok: false, error: "Cantidad inválida" });
      }
      nextQty = qN;
    }

    let nextUnitPrice = item.unit_price;
    if (unit_price !== undefined) {
      const pN = Number(unit_price);
      if (!Number.isFinite(pN) || pN < 0) {
        return res.status(400).json({ ok: false, error: "Precio inválido" });
      }
      nextUnitPrice = pN;
    }

    let nextDiscount = item.line_discount;
    if (line_discount !== undefined) {
      const dN = Number(line_discount);
      if (!Number.isFinite(dN) || dN < 0) {
        return res.status(400).json({ ok: false, error: "Descuento inválido" });
      }
      nextDiscount = dN;
    }

    let nextTaxRate = item.tax_rate;
    if (tax_rate !== undefined) {
      if (tax_rate === null) {
        nextTaxRate = null;
      } else {
        const tr = Number(tax_rate);
        if (!Number.isNaN(tr)) {
          nextTaxRate = tr;
        }
      }
    }

    const { discount, tax, total } = calcLineTotals(
      nextUnitPrice,
      nextQty,
      nextDiscount,
      nextTaxRate
    );

    item.qty = nextQty;
    item.unit_price = nextUnitPrice;
    item.line_discount = discount;
    item.tax_rate = nextTaxRate;
    item.tax_amount = tax;
    item.line_total = total;

    await item.save();

    const delta = nextQty - originalQty;
    if (delta > 0) {
      await increaseReservation(tab._id, item.product._id, delta, req.user && req.user.id);
    } else if (delta < 0) {
      await decreaseReservation(tab._id, item.product._id, -delta);
    }

    const fullItem = await TabItem.findById(item._id).populate("product");

    return res.json({
      ok: true,
      item: fullItem.toJSON(),
    });
  } catch (error) {
    console.error("Error al actualizar ítem de mesa:", error.message);
    return res.status(500).json({ ok: false, error: "Error al actualizar ítem de mesa" });
  }
});

// Elimina un ítem de mesa y ajusta la reserva de stock
router.delete("/items/:itemId", authMiddleware, async (req, res) => {
  try {
    const { itemId } = req.params;

    const item = await TabItem.findById(itemId);

    if (!item) {
      return res.status(404).json({ ok: false, error: "Ítem no encontrado" });
    }

    const tab = await Tab.findById(item.tab);

    if (!tab) {
      return res.status(404).json({ ok: false, error: "Mesa no encontrada" });
    }

    if (tab.status !== "OPEN") {
      return res.status(400).json({ ok: false, error: "La mesa no está abierta" });
    }

    const qty = item.qty;

    await TabItem.deleteOne({ _id: item._id });

    await decreaseReservation(tab._id, item.product, qty);

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error al eliminar ítem de mesa:", error.message);
    return res.status(500).json({ ok: false, error: "Error al eliminar ítem de mesa" });
  }
});

// Limpia todos los ítems de una mesa y elimina reservas asociadas
router.post("/:id/clear", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const tab = await Tab.findById(id);

    if (!tab) {
      return res.status(404).json({ ok: false, error: "Mesa no encontrada" });
    }

    await TabItem.deleteMany({ tab: tab._id });

    await StockReservation.deleteMany({
      tab: tab._id,
      consumed: false,
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error al limpiar mesa:", error.message);
    return res.status(500).json({ ok: false, error: "Error al limpiar mesa" });
  }
});

// Cierra una mesa
router.post("/:id/close", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const tab = await Tab.findById(id);

    if (!tab) {
      return res.status(404).json({ ok: false, error: "Mesa no encontrada" });
    }

    if (tab.status === "CLOSED") {
      return res.json({ ok: true, tab: tab.toJSON() });
    }

    tab.status = "CLOSED";
    tab.closed_at = new Date();
    await tab.save();

    return res.json({
      ok: true,
      tab: tab.toJSON(),
    });
  } catch (error) {
    console.error("Error al cerrar mesa:", error.message);
    return res.status(500).json({ ok: false, error: "Error al cerrar mesa" });
  }
});

// Reabre una mesa cerrada
router.post("/:id/reopen", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const tab = await Tab.findById(id);

    if (!tab) {
      return res.status(404).json({ ok: false, error: "Mesa no encontrada" });
    }

    tab.status = "OPEN";
    tab.closed_at = null;
    await tab.save();

    return res.json({
      ok: true,
      tab: tab.toJSON(),
    });
  } catch (error) {
    console.error("Error al reabrir mesa:", error.message);
    return res.status(500).json({ ok: false, error: "Error al reabrir mesa" });
  }
});

// Obtiene los totales de una mesa
router.get("/:id/totals", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const tab = await Tab.findById(id);

    if (!tab) {
      return res.status(404).json({ ok: false, error: "Mesa no encontrada" });
    }

    const items = await TabItem.find({ tab: tab._id });

    const totals = computeTabTotals(items);

    return res.json({
      ok: true,
      totals,
    });
  } catch (error) {
    console.error("Error al obtener totales de mesa:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener totales de mesa" });
  }
});

// Devuelve un payload de venta basado en los ítems de la mesa
router.get("/:id/payload-for-sale", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const tab = await Tab.findById(id);

    if (!tab) {
      return res.status(404).json({ ok: false, error: "Mesa no encontrada" });
    }

    const items = await TabItem.find({ tab: tab._id }).populate("product");

    if (items.length === 0) {
      return res.status(400).json({ ok: false, error: "La mesa no tiene ítems" });
    }

    const totals = computeTabTotals(items);

    const saleItems = items.map((it) => ({
      productId: it.product.id,
      qty: it.qty,
      unit_price: it.unit_price,
      line_discount: it.line_discount,
      tax_rate: it.tax_rate,
    }));

    return res.json({
      ok: true,
      tab_id: tab.id,
      tab_name: tab.name,
      totals,
      items: saleItems,
    });
  } catch (error) {
    console.error("Error al generar payload de venta para mesa:", error.message);
    return res
      .status(500)
      .json({ ok: false, error: "Error al generar payload de venta para mesa" });
  }
});

// Elimina una mesa cerrada y sus datos relacionados
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const tab = await Tab.findById(id);

    if (!tab) {
      return res.status(404).json({ ok: false, error: "Mesa no encontrada" });
    }

    if (tab.status !== "CLOSED") {
      return res
        .status(400)
        .json({ ok: false, error: "Solo se pueden eliminar mesas cerradas" });
    }

    await TabItem.deleteMany({ tab: tab._id });

    await StockReservation.deleteMany({ tab: tab._id });

    await Tab.deleteOne({ _id: tab._id });

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error al eliminar mesa:", error.message);
    return res.status(500).json({ ok: false, error: "Error al eliminar mesa" });
  }
});

// Exporta el router configurado para mesas
module.exports = {
  tabsRouter: router,
};

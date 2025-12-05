const express = require("express");
const Product = require("../models/Product");
const InventoryMove = require("../models/InventoryMove");
const { authMiddleware } = require("./auth.routes");
const {
  normalizeKind,
  mapInvTypeToKind,
  mapKindToInvType,
  normalizeMeasureForKind,
} = require("../lib/productTypes");

// Crea el router para agrupar las rutas de productos
const router = express.Router();

// Define un middleware para asegurar que el usuario tenga rol admin
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Acceso restringido a administradores" });
  }
  next();
}

// Define la ruta para obtener la lista de productos con filtros avanzados
router.get("/", authMiddleware, async (req, res) => {
  try {
    const {
      q = "",
      include_inactive = "false",
      inv_type,
      type,
      category,
      limit = "500",
      offset = "0",
    } = req.query;

    const text = String(q || "").trim();
    const invTypeArg = inv_type ? String(inv_type).toUpperCase() : null;
    const typeArg = type ? String(type).toUpperCase() : null;

    const wantKind = invTypeArg
      ? mapInvTypeToKind(invTypeArg)
      : typeArg
      ? normalizeKind(typeArg)
      : null;

    const filter = {};

    if (!text && !category && !wantKind && include_inactive !== "true") {
      filter.is_active = true;
    }

    if (text) {
      const regex = new RegExp(text, "i");
      filter.$or = [{ name: regex }, { category: regex }];
    }

    if (category) {
      filter.category = category;
    }

    if (wantKind) {
      filter.kind = wantKind;
    }

    if (include_inactive === "false") {
      filter.is_active = true;
    }

    const lim = Math.max(1, Math.min(1000, Number(limit) || 500));
    const off = Math.max(0, Number(offset) || 0);

    const products = await Product.find(filter)
      .sort({ name: 1 })
      .skip(off)
      .limit(lim);

    const items = products.map((p) => {
      const obj = p.toJSON();
      obj.inv_type = mapKindToInvType(obj.kind);
      return obj;
    });

    return res.json({
      ok: true,
      items,
      total: items.length,
    });
  } catch (error) {
    console.error("Error al listar productos:", error.message);
    return res.status(500).json({ ok: false, error: "Error al listar productos" });
  }
});

// Define la ruta para obtener un producto específico por su identificador
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({ ok: false, error: "Producto no encontrado" });
    }

    const obj = product.toJSON();
    obj.inv_type = mapKindToInvType(obj.kind);

    return res.json({
      ok: true,
      product: obj,
    });
  } catch (error) {
    console.error("Error al obtener producto:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener producto" });
  }
});

// Define la ruta para obtener el resumen de categorías activas
router.get("/_meta/categories", authMiddleware, async (_req, res) => {
  try {
    const rows = await Product.aggregate([
      { $match: { is_active: true } },
      {
        $group: {
          _id: {
            $trim: { input: { $ifNull: ["$category", ""] } },
          },
          n: { $sum: 1 },
        },
      },
      { $sort: { "_id": 1 } },
    ]);

    const items = rows.map((r) => ({
      category: r._id || "Sin categoría",
      n: r.n,
    }));

    return res.json({
      ok: true,
      items,
      total: items.length,
    });
  } catch (error) {
    console.error("Error al obtener categorías de productos:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener categorías de productos" });
  }
});

// Define la ruta para crear un nuevo producto con ajuste de stock opcional
router.post("/", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const payload = req.body || {};
    const incomingKind =
      payload.kind ??
      payload.type ??
      payload.product_type ??
      (payload.inv_type ? mapInvTypeToKind(payload.inv_type) : undefined);

    const kind = normalizeKind(incomingKind);
    const {
      name,
      category = "",
      stock = 0,
      min_stock = 0,
      measure,
    } = payload;

    const priceN = Number(payload.price);

    if (!name || (kind !== "BASE" && kind !== "ACCOMP" && Number.isNaN(priceN))) {
      return res.status(400).json({ ok: false, error: "Datos inválidos para producto" });
    }

    const stockN = Math.max(0, parseInt(stock, 10) || 0);
    const minStockN = Math.max(0, parseInt(min_stock, 10) || 0);

    const normalizedMeasure = normalizeMeasureForKind(kind, measure);

    const priceFinal = kind === "BASE" || kind === "ACCOMP" ? 0 : priceN;

    const product = await Product.create({
      name,
      category: String(category || "").trim(),
      price: priceFinal,
      stock: 0,
      min_stock: minStockN,
      is_active: true,
      kind,
      inv_type: mapKindToInvType(kind),
      measure: normalizedMeasure,
    });

    if (stockN > 0) {
      const move = await InventoryMove.create({
        product: product._id,
        qty: stockN,
        note: "Stock inicial al crear producto",
        user: req.user ? req.user.id : null,
        type: "ADJUST",
        sourceRef: null,
        location: null,
        supplierId: null,
        supplierName: null,
        invoiceNumber: null,
        unitCost: null,
        discount: null,
        tax: null,
        lot: null,
        expiryDate: null,
      });

      product.stock = product.stock + stockN;
      await product.save();
    }

    const fresh = await Product.findById(product._id);
    const obj = fresh.toJSON();
    obj.inv_type = mapKindToInvType(obj.kind);

    return res.status(201).json({
      ok: true,
      product: obj,
    });
  } catch (error) {
    console.error("Error al crear producto:", error.message);
    return res.status(500).json({ ok: false, error: "Error al crear producto" });
  }
});

// Define la ruta para actualizar un producto y registrar ajuste de stock si cambia
router.put("/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body || {};
    const product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({ ok: false, error: "Producto no encontrado" });
    }

    const incomingKind =
      payload.kind ??
      payload.type ??
      payload.product_type ??
      (payload.inv_type ? mapInvTypeToKind(payload.inv_type) : undefined);

    const nextKind = incomingKind == null ? product.kind : normalizeKind(incomingKind);

    const nextMeasure = normalizeMeasureForKind(nextKind, payload.measure ?? product.measure);

    let nextPrice;

    if (nextKind === "BASE" || nextKind === "ACCOMP") {
      nextPrice = 0;
    } else if (payload.price !== undefined) {
      const priceN = Number(payload.price);
      if (Number.isNaN(priceN)) {
        return res.status(400).json({ ok: false, error: "Precio inválido" });
      }
      nextPrice = priceN;
    } else {
      nextPrice = product.price;
    }

    const currentStock = product.stock;
    let requestedStock = payload.stock;

    let deltaRequested = 0;

    if (requestedStock !== undefined) {
      const stockN = Math.max(0, parseInt(requestedStock, 10) || 0);
      deltaRequested = stockN - currentStock;
      product.stock = stockN;
    }

    if (payload.name !== undefined) {
      product.name = payload.name;
    }

    if (payload.category !== undefined) {
      product.category = String(payload.category || "").trim();
    }

    if (payload.min_stock !== undefined) {
      product.min_stock = Math.max(0, parseInt(payload.min_stock, 10) || 0);
    }

    product.price = nextPrice;
    product.kind = nextKind;
    product.inv_type = mapKindToInvType(nextKind);
    product.measure = nextMeasure;

    await product.save();

    if (deltaRequested !== 0) {
      await InventoryMove.create({
        product: product._id,
        qty: deltaRequested,
        note: "Ajuste desde products:update",
        user: req.user ? req.user.id : null,
        type: "ADJUST",
        sourceRef: null,
        location: null,
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

    const fresh = await Product.findById(id);
    const obj = fresh.toJSON();
    obj.inv_type = mapKindToInvType(obj.kind);

    return res.json({
      ok: true,
      product: obj,
    });
  } catch (error) {
    console.error("Error al actualizar producto:", error.message);
    return res.status(500).json({ ok: false, error: "Error al actualizar producto" });
  }
});

// Define la ruta para cambiar el estado activo de un producto
router.patch("/:id/status", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    const product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({ ok: false, error: "Producto no encontrado" });
    }

    product.is_active = Boolean(is_active);
    await product.save();

    const obj = product.toJSON();
    obj.inv_type = mapKindToInvType(obj.kind);

    return res.json({
      ok: true,
      product: obj,
    });
  } catch (error) {
    console.error("Error al cambiar estado de producto:", error.message);
    return res.status(500).json({ ok: false, error: "Error al cambiar estado de producto" });
  }
});

// Define la ruta para eliminar un producto verificando que no tenga movimientos
router.delete("/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({ ok: false, error: "Producto no encontrado" });
    }

    const hasMoves = await InventoryMove.exists({ product: id });

    if (hasMoves) {
      return res.status(400).json({
        ok: false,
        error: "No se puede eliminar: el producto ya tiene movimientos. Desactívalo en su lugar.",
      });
    }

    await Product.deleteOne({ _id: id });

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error al eliminar producto:", error.message);
    return res.status(500).json({ ok: false, error: "Error al eliminar producto" });
  }
});

// Exporta el router configurado para productos
module.exports = {
  productsRouter: router,
};

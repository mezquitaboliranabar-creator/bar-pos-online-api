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

// Middleware para asegurar que el usuario tenga rol admin
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res
      .status(403)
      .json({ ok: false, error: "Acceso restringido a administradores" });
  }
  next();
}

/* ========== RUTAS DE METADATOS (CATEGORÍAS) ========== */

// Handler común para categorías activas
async function handleCategories(req, res) {
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
      { $sort: { _id: 1 } },
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
    return res
      .status(500)
      .json({ ok: false, error: "Error al obtener categorías de productos" });
  }
}

// Alias nuevo: /api/products/categories (para el frontend)
router.get("/categories", authMiddleware, handleCategories);

// Ruta original: /api/products/_meta/categories
router.get("/_meta/categories", authMiddleware, handleCategories);

/* ========== LISTADO Y DETALLE ========== */

// Lista de productos con filtros avanzados
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
    return res
      .status(500)
      .json({ ok: false, error: "Error al listar productos" });
  }
});

// Detalle de un producto por id
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findById(id);

    if (!product) {
      return res
        .status(404)
        .json({ ok: false, error: "Producto no encontrado" });
    }

    const obj = product.toJSON();
    obj.inv_type = mapKindToInvType(obj.kind);

    return res.json({
      ok: true,
      product: obj,
    });
  } catch (error) {
    console.error("Error al obtener producto:", error.message);
    return res
      .status(500)
      .json({ ok: false, error: "Error al obtener producto" });
  }
});

/* ========== CREAR / ACTUALIZAR / ESTADO / ELIMINAR ========== */

// Crear un nuevo producto con ajuste de stock opcional
router.post("/", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const payload = req.body || {};
    const incomingKind =
      payload.kind ??
      payload.type ??
      payload.product_type ??
      (payload.inv_type ? mapInvTypeToKind(payload.inv_type) : undefined);

    const kind = normalizeKind(incomingKind);
    const { name, category = "", stock = 0, min_stock = 0, measure } = payload;

    const priceN = Number(payload.price);

    // Para BASE / ACCOMP el precio se ignora; para STANDARD / COCKTAIL se exige número
    if (
      !name ||
      (kind !== "BASE" &&
        kind !== "ACCOMP" &&
        (Number.isNaN(priceN) || priceN < 0))
    ) {
      return res
        .status(400)
        .json({ ok: false, error: "Datos inválidos para producto" });
    }

    // Para cócteles, el stock no se maneja manualmente
    const allowManualStock = kind !== "COCKTAIL";

    const stockN = allowManualStock
      ? Math.max(0, parseInt(stock, 10) || 0)
      : 0;
    const minStockN = Math.max(0, parseInt(min_stock, 10) || 0);

    const normalizedMeasure = normalizeMeasureForKind(kind, measure);

    // Para BASE/ACCOMP el precio de venta es 0; STANDARD/COCKTAIL usan el precio indicado
    const priceFinal =
      kind === "BASE" || kind === "ACCOMP" ? 0 : priceN || 0;

    const product = await Product.create({
      name,
      category: String(category || "").trim(),
      price: priceFinal,
      stock: 0, // el stock de cocteles se deriva de los ingredientes
      min_stock: minStockN,
      is_active: true,
      kind,
      inv_type: mapKindToInvType(kind),
      measure: normalizedMeasure,
    });

    // Solo crear movimiento de stock inicial si el producto NO es COCKTAIL
    if (allowManualStock && stockN > 0) {
      await InventoryMove.create({
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

    // Devolvemos product e item para compatibilidad con el frontend
    return res.status(201).json({
      ok: true,
      product: obj,
      item: obj,
    });
  } catch (error) {
    console.error("Error al crear producto:", error.message);
    return res
      .status(500)
      .json({ ok: false, error: "Error al crear producto" });
  }
});

// Actualizar un producto y registrar ajuste de stock si cambia
router.put("/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body || {};
    const product = await Product.findById(id);

    if (!product) {
      return res
        .status(404)
        .json({ ok: false, error: "Producto no encontrado" });
    }

    const incomingKind =
      payload.kind ??
      payload.type ??
      payload.product_type ??
      (payload.inv_type ? mapInvTypeToKind(payload.inv_type) : undefined);

    const nextKind =
      incomingKind == null ? product.kind : normalizeKind(incomingKind);

    const nextMeasure = normalizeMeasureForKind(
      nextKind,
      payload.measure ?? product.measure
    );

    let nextPrice;

    if (nextKind === "BASE" || nextKind === "ACCOMP") {
      nextPrice = 0;
    } else if (payload.price !== undefined) {
      const priceN = Number(payload.price);
      if (Number.isNaN(priceN) || priceN < 0) {
        return res.status(400).json({ ok: false, error: "Precio inválido" });
      }
      nextPrice = priceN;
    } else {
      nextPrice = product.price;
    }

    const currentStock = product.stock;
    let deltaRequested = 0;

    // Para COCKTAIL no se admite stock manual; se fuerza a 0
    if (nextKind === "COCKTAIL") {
      if (currentStock !== 0) {
        deltaRequested = -currentStock;
        product.stock = 0;
      }
    } else if (payload.stock !== undefined) {
      const stockN = Math.max(0, parseInt(payload.stock, 10) || 0);
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
      product.min_stock = Math.max(
        0,
        parseInt(payload.min_stock, 10) || 0
      );
    }

    // Permite actualizar estado activo desde PUT si viene en el payload
    if (payload.is_active !== undefined) {
      product.is_active = Boolean(payload.is_active);
    } else if (payload.isActive !== undefined) {
      product.is_active = Boolean(payload.isActive);
    }

    product.price = nextPrice;
    product.kind = nextKind;
    product.inv_type = mapKindToInvType(nextKind);
    product.measure = nextMeasure;

    await product.save();

    // Solo registramos movimiento de ajuste si realmente hay delta
    if (deltaRequested !== 0) {
      await InventoryMove.create({
        product: product._id,
        qty: deltaRequested,
        note:
          nextKind === "COCKTAIL"
            ? "Ajuste a 0 al convertir en cóctel"
            : "Ajuste desde products:update",
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

    // Devolvemos product e item para el frontend
    return res.json({
      ok: true,
      product: obj,
      item: obj,
    });
  } catch (error) {
    console.error("Error al actualizar producto:", error.message);
    return res
      .status(500)
      .json({ ok: false, error: "Error al actualizar producto" });
  }
});

// Cambiar el estado activo de un producto
router.patch("/:id/status", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active, isActive } = req.body;

    const product = await Product.findById(id);

    if (!product) {
      return res
        .status(404)
        .json({ ok: false, error: "Producto no encontrado" });
    }

    const next = is_active !== undefined ? is_active : isActive;
    product.is_active = Boolean(next);
    await product.save();

    const obj = product.toJSON();
    obj.inv_type = mapKindToInvType(obj.kind);

    return res.json({
      ok: true,
      product: obj,
      item: obj,
    });
  } catch (error) {
    console.error("Error al cambiar estado de producto:", error.message);
    return res
      .status(500)
      .json({ ok: false, error: "Error al cambiar estado de producto" });
  }
});

// Eliminar un producto verificando que no tenga movimientos
router.delete("/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findById(id);

    if (!product) {
      return res
        .status(404)
        .json({ ok: false, error: "Producto no encontrado" });
    }

    const hasMoves = await InventoryMove.exists({ product: id });

    if (hasMoves) {
      return res.status(400).json({
        ok: false,
        error:
          "No se puede eliminar: el producto ya tiene movimientos. Desactívalo en su lugar.",
      });
    }

    await Product.deleteOne({ _id: id });

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error al eliminar producto:", error.message);
    return res
      .status(500)
      .json({ ok: false, error: "Error al eliminar producto" });
  }
});

// Exporta el router configurado para productos
module.exports = {
  productsRouter: router,
};

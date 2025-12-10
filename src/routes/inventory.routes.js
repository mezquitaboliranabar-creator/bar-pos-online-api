const express = require("express");
const InventoryMove = require("../models/InventoryMove");
const Product = require("../models/Product");
const { authMiddleware } = require("./auth.routes");

// Crea el router para agrupar las rutas de inventario
const router = express.Router();

// Middleware para restringir acceso a administradores
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res
      .status(403)
      .json({ ok: false, error: "Acceso restringido a administradores" });
  }
  next();
}

// Calcula el costo total de un movimiento
function computeCostTotal(move) {
  const unitCost = Number(move.unitCost ?? 0);
  const qty = Number(move.qty ?? 0);
  const discount = Number(move.discount ?? 0);
  const tax = Number(move.tax ?? 0);
  return unitCost * qty - discount + tax;
}

// Lista movimientos de inventario con filtros
router.get("/moves", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const {
      q = "",
      productId,
      from,
      to,
      type,
      category,
      location,
      inv_type,
      limit = "100",
      offset = "0",
    } = req.query;

    const filter = {};
    const and = [];

    if (productId) {
      and.push({ product: productId });
    }

    if (type) {
      and.push({ type: String(type).toUpperCase() });
    }

    if (location) {
      and.push({ location });
    }

    if (from || to) {
      const range = {};
      if (from) range.$gte = new Date(from);
      if (to) range.$lte = new Date(to);
      and.push({ createdAt: range });
    }

    if (q) {
      const regex = new RegExp(String(q).trim(), "i");
      and.push({
        $or: [{ note: regex }, { invoiceNumber: regex }],
      });
    }

    if (category || inv_type) {
      const prodFilter = {};
      if (category) prodFilter.category = category;
      if (inv_type) prodFilter.inv_type = String(inv_type).toUpperCase();
      const prodIds = await Product.find(prodFilter).distinct("_id");
      and.push({ product: { $in: prodIds } });
    }

    if (and.length > 0) {
      filter.$and = and;
    }

    const lim = Math.max(1, Math.min(500, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);

    const moves = await InventoryMove.find(filter)
      .populate("product")
      .populate("user", "username name role")
      .sort({ createdAt: -1, _id: -1 })
      .skip(off)
      .limit(lim);

    const items = moves.map((m) => {
      const obj = m.toJSON();
      obj.cost_total = computeCostTotal(obj);
      return obj;
    });

    return res.json({
      ok: true,
      items,
      total: items.length,
    });
  } catch (error) {
    console.error("Error al listar movimientos de inventario:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Error al listar movimientos de inventario",
    });
  }
});

// Detalle de un movimiento de inventario
router.get("/moves/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const move = await InventoryMove.findById(id)
      .populate("product")
      .populate("user", "username name role");

    if (!move) {
      return res
        .status(404)
        .json({ ok: false, error: "Movimiento no encontrado" });
    }

    const obj = move.toJSON();
    obj.cost_total = computeCostTotal(obj);

    return res.json({
      ok: true,
      move: obj,
    });
  } catch (error) {
    console.error("Error al obtener movimiento de inventario:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Error al obtener movimiento de inventario",
    });
  }
});

// Editar un movimiento de inventario y ajustar stock
router.put("/moves/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      qty,
      note,
      location,
      supplierId,
      supplierName,
      invoiceNumber,
      unitCost,
      discount,
      tax,
      lot,
      expiryDate,
      type,
    } = req.body || {};

    const move = await InventoryMove.findById(id);

    if (!move) {
      return res
        .status(404)
        .json({ ok: false, error: "Movimiento no encontrado" });
    }

    const product = await Product.findById(move.product);

    if (!product) {
      return res
        .status(404)
        .json({ ok: false, error: "Producto no encontrado" });
    }

    const currentStock = Number(product.stock || 0);
    const oldQty = Number(move.qty || 0);

    const newQtyRaw =
      qty !== undefined && qty !== null && qty !== ""
        ? Number(qty)
        : oldQty;

    if (!Number.isFinite(newQtyRaw) || newQtyRaw < 0) {
      return res.status(400).json({
        ok: false,
        error: "qty debe ser un número válido mayor o igual a 0",
      });
    }

    const newQty = newQtyRaw;
    const delta = newQty - oldQty;
    const newStock = currentStock + delta;

    if (newStock < 0) {
      return res.status(400).json({
        ok: false,
        error: "La edición dejaría el stock negativo",
      });
    }

    product.stock = newStock;
    await product.save();

    move.qty = newQty;

    if (note !== undefined) {
      move.note = note || "";
    }
    if (location !== undefined) {
      move.location = location || null;
    }
    if (supplierId !== undefined) {
      move.supplierId =
        supplierId !== null && supplierId !== ""
          ? Number(supplierId)
          : null;
    }
    if (supplierName !== undefined) {
      move.supplierName = supplierName || null;
    }
    if (invoiceNumber !== undefined) {
      move.invoiceNumber = invoiceNumber || null;
    }

    if (unitCost !== undefined) {
      if (unitCost === null || unitCost === "") {
        move.unitCost = null;
      } else {
        move.unitCost = Number(unitCost);
      }
    }

    if (discount !== undefined) {
      if (discount === null || discount === "") {
        move.discount = null;
      } else {
        move.discount = Number(discount);
      }
    }

    if (tax !== undefined) {
      if (tax === null || tax === "") {
        move.tax = null;
      } else {
        move.tax = Number(tax);
      }
    }

    if (lot !== undefined) {
      move.lot = lot || null;
    }

    if (expiryDate !== undefined) {
      move.expiryDate = expiryDate ? new Date(expiryDate) : null;
    }

    if (type !== undefined) {
      move.type = type ? String(type).toUpperCase() : null;
    }

    await move.save();

    const obj = move.toJSON();
    obj.cost_total = computeCostTotal(obj);

    return res.json({
      ok: true,
      move: obj,
      product: product.toJSON(),
    });
  } catch (error) {
    console.error("Error al editar movimiento de inventario:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Error al editar movimiento de inventario",
    });
  }
});

// Crear un movimiento general de inventario
router.post("/moves", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const {
      productId,
      qty,
      type,
      note,
      location,
      supplierId,
      supplierName,
      invoiceNumber,
      unitCost,
      discount,
      tax,
      lot,
      expiryDate,
      sourceRef,
    } = req.body;

    const numericQty = Number(qty);

    if (!productId || !numericQty || !Number.isFinite(numericQty)) {
      return res.status(400).json({
        ok: false,
        error: "productId y qty válidos son requeridos",
      });
    }

    const product = await Product.findById(productId);

    if (!product) {
      return res
        .status(404)
        .json({ ok: false, error: "Producto no encontrado" });
    }

    const delta = numericQty;
    const newStock = product.stock + delta;

    if (newStock < 0) {
      return res.status(400).json({
        ok: false,
        error: "El movimiento dejaría stock negativo",
      });
    }

    product.stock = newStock;
    await product.save();

    const move = await InventoryMove.create({
      product: product._id,
      qty: delta,
      note: note || "",
      user: req.user ? req.user.id : null,
      type: type ? String(type).toUpperCase() : null,
      sourceRef: sourceRef || null,
      location: location || null,
      supplierId: supplierId || null,
      supplierName: supplierName || null,
      invoiceNumber: invoiceNumber || null,
      unitCost:
        unitCost !== undefined && unitCost !== null ? Number(unitCost) : null,
      discount:
        discount !== undefined && discount !== null ? Number(discount) : null,
      tax: tax !== undefined && tax !== null ? Number(tax) : null,
      lot: lot || null,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
    });

    const obj = move.toJSON();
    obj.cost_total = computeCostTotal(obj);

    return res.status(201).json({
      ok: true,
      move: obj,
      product: product.toJSON(),
    });
  } catch (error) {
    console.error("Error al crear movimiento de inventario:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Error al crear movimiento de inventario",
    });
  }
});

// Ingreso rápido de stock para un producto
router.post("/add-stock", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { productId, qty, note, location } = req.body;

    const numericQty = Number(qty);

    if (!productId || !(numericQty > 0)) {
      return res.status(400).json({
        ok: false,
        error: "productId y qty > 0 son requeridos",
      });
    }

    const product = await Product.findById(productId);

    if (!product || !product.is_active) {
      return res.status(404).json({
        ok: false,
        error: "Producto no encontrado o inactivo",
      });
    }

    const newStock = product.stock + numericQty;

    product.stock = newStock;
    await product.save();

    const move = await InventoryMove.create({
      product: product._id,
      qty: numericQty,
      note: note || "Ingreso rápido de inventario",
      user: req.user ? req.user.id : null,
      type: "IN",
      sourceRef: null,
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

    const obj = move.toJSON();
    obj.cost_total = computeCostTotal(obj);

    return res.status(201).json({
      ok: true,
      move: obj,
      product: product.toJSON(),
    });
  } catch (error) {
    console.error("Error en add-stock de inventario:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Error en add-stock de inventario",
    });
  }
});

// Ajustar el stock de un producto a un valor específico
router.post("/adjust", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { productId, stock, note, location } = req.body;

    const product = await Product.findById(productId);

    if (!product) {
      return res
        .status(404)
        .json({ ok: false, error: "Producto no encontrado" });
    }

    const currentStock = Number(product.stock || 0);
    const requestedStock = Math.max(0, Number(stock) || 0);
    const delta = requestedStock - currentStock;

    if (delta === 0) {
      return res.json({
        ok: true,
        delta: 0,
        product: product.toJSON(),
      });
    }

    const newStock = currentStock + delta;

    if (newStock < 0) {
      return res.status(400).json({
        ok: false,
        error: "El ajuste dejaría stock negativo",
      });
    }

    product.stock = newStock;
    await product.save();

    const move = await InventoryMove.create({
      product: product._id,
      qty: delta,
      note: note || "Ajuste de inventario",
      user: req.user ? req.user.id : null,
      type: "ADJUST",
      sourceRef: null,
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

    const obj = move.toJSON();
    obj.cost_total = computeCostTotal(obj);

    return res.json({
      ok: true,
      delta,
      move: obj,
      product: product.toJSON(),
    });
  } catch (error) {
    console.error("Error al ajustar stock de inventario:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Error al ajustar stock de inventario",
    });
  }
});

// Ingreso con proveedor / factura (múltiples líneas)
router.post("/receive", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const {
      items,
      location,
      supplierId,
      supplierName,
      invoiceNumber,
      note,
    } = req.body || {};

    const lines = Array.isArray(items) ? items : [];

    if (!lines.length) {
      return res.status(400).json({
        ok: false,
        error: "No hay líneas para registrar el ingreso",
      });
    }

    const createdMoves = [];
    let invoiceTotal = 0;

    for (const line of lines) {
      const productId = line.productId || line.product_id;
      const qtyN = Number(line.qty);

      if (!productId || !(qtyN > 0)) {
        continue;
      }

      const unitCost =
        line.unitCost !== undefined && line.unitCost !== null
          ? Number(line.unitCost)
          : line.unit_cost !== undefined && line.unit_cost !== null
          ? Number(line.unit_cost)
          : null;

      const discount =
        line.discount !== undefined && line.discount !== null
          ? Number(line.discount)
          : null;

      const tax =
        line.tax !== undefined && line.tax !== null ? Number(line.tax) : null;

      const lot = line.lot || null;
      const expiryRaw = line.expiryDate || line.expiry_date || null;
      const expiryDate = expiryRaw ? new Date(expiryRaw) : null;

      const product = await Product.findById(productId);

      if (!product || !product.is_active) {
        return res.status(404).json({
          ok: false,
          error: "Producto no encontrado o inactivo en una de las líneas",
        });
      }

      const newStock = product.stock + qtyN;

      if (newStock < 0) {
        return res.status(400).json({
          ok: false,
          error: "El ingreso dejaría stock negativo en una de las líneas",
        });
      }

      product.stock = newStock;
      await product.save();

      const move = await InventoryMove.create({
        product: product._id,
        qty: qtyN,
        note: note || "Ingreso de proveedor",
        user: req.user ? req.user.id : null,
        type: "IN",
        sourceRef: null,
        location: location || null,
        supplierId: supplierId || null,
        supplierName: supplierName || null,
        invoiceNumber: invoiceNumber || null,
        unitCost,
        discount,
        tax,
        lot,
        expiryDate,
      });

      const obj = move.toJSON();
      obj.cost_total = computeCostTotal(obj);
      invoiceTotal += obj.cost_total;
      createdMoves.push(obj);
    }

    if (!createdMoves.length) {
      return res.status(400).json({
        ok: false,
        error: "No se pudo registrar ninguna línea de ingreso",
      });
    }

    return res.status(201).json({
      ok: true,
      moves: createdMoves,
      total: createdMoves.length,
      invoice_total: invoiceTotal,
    });
  } catch (error) {
    console.error("Error en receive de inventario:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Error en receive de inventario",
    });
  }
});

// Eliminar un movimiento de inventario y revertir stock
router.delete("/moves/:id", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const move = await InventoryMove.findById(id);

    if (!move) {
      return res
        .status(404)
        .json({ ok: false, error: "Movimiento no existe" });
    }

    const product = await Product.findById(move.product);

    if (!product) {
      return res
        .status(404)
        .json({ ok: false, error: "Producto no existe" });
    }

    const newStock = Number(product.stock || 0) - Number(move.qty || 0);

    if (newStock < 0) {
      return res.status(400).json({
        ok: false,
        error: "No se puede revertir: dejaría stock negativo",
      });
    }

    product.stock = newStock;
    await product.save();

    await InventoryMove.deleteOne({ _id: move._id });

    return res.json({ ok: true });
  } catch (error) {
    console.error("Error al eliminar movimiento de inventario:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Error al eliminar movimiento de inventario",
    });
  }
});

// Resumen de productos con bajo stock
router.get("/low-stock", authMiddleware, requireAdmin, async (_req, res) => {
  try {
    const products = await Product.find({
      is_active: true,
      min_stock: { $gt: 0 },
      $expr: { $lte: ["$stock", "$min_stock"] },
    }).sort({
      min_stock: 1,
      category: 1,
      name: 1,
    });

    const items = products.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      stock: p.stock,
      min_stock: p.min_stock,
    }));

    return res.json({
      ok: true,
      items,
      total: items.length,
    });
  } catch (error) {
    console.error("Error al obtener resumen de bajo stock:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Error al obtener resumen de bajo stock",
    });
  }
});

// Exportar inventario en JSON para informes o CSV
router.post("/export", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { include_inactive = false, category, inv_type } = req.body || {};

    const filter = {};
    if (!include_inactive) {
      filter.is_active = true;
    }
    if (category) {
      filter.category = category;
    }
    if (inv_type) {
      filter.inv_type = String(inv_type).toUpperCase();
    }

    const products = await Product.find(filter).sort({
      category: 1,
      name: 1,
    });

    const items = products.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      stock: p.stock,
      min_stock: p.min_stock,
      price: p.price,
      inv_type: p.inv_type,
      kind: p.kind,
      measure: p.measure,
    }));

    return res.json({
      ok: true,
      items,
      total: items.length,
    });
  } catch (error) {
    console.error("Error al exportar inventario:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Error al exportar inventario",
    });
  }
});

// Exporta el router configurado para inventario
module.exports = {
  inventoryRouter: router,
};

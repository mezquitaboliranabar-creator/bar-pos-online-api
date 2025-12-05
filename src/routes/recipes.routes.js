const express = require("express");
const { authMiddleware } = require("./auth.routes");
const Product = require("../models/Product");
const ProductRecipe = require("../models/ProductRecipe");

// Crea el router para agrupar las rutas de recetas
const router = express.Router();

// Define un middleware para restringir acceso de escritura a administradores
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Acceso restringido a administradores" });
  }
  next();
}

// Define la categoría de medida para validar unidades de recetas
function measureCategory(measure) {
  const m = String(measure || "").toUpperCase();
  if (m === "ML") return "VOLUME";
  if (m === "G") return "MASS";
  if (m === "UNIT") return "UNIT";
  return null;
}

// Define tablas de conversión para unidades de volumen y masa
const VOL_TO_ML = { ML: 1, L: 1000, CL: 10, OZ: 29.57, SHOT: 44 };
const MASS_TO_G = { G: 1, KG: 1000, LB: 453.592 };

// Carga la receta de un producto con detalles de ingredientes
async function loadRecipeForProduct(product) {
  const rows = await ProductRecipe.find({ product: product._id })
    .populate("ingredient")
    .sort({ "ingredient.name": 1, _id: 1 });

  const items = rows.map((r) => {
    const ing = r.ingredient;
    return {
      id: r.id,
      product_id: product.id,
      ingredient_id: ing ? ing.id : null,
      ingredient_name: ing ? ing.name : null,
      ingredient_type: ing ? (ing.inv_type || ing.kind || null) : null,
      ingredient_measure: ing ? ing.measure || null : null,
      qty: r.qty,
      role: r.role,
      unit: r.unit,
      note: r.note,
    };
  });

  return {
    ok: true,
    product: {
      id: product.id,
      name: product.name,
      category: product.category,
      kind: product.kind,
      inv_type: product.inv_type,
      measure: product.measure,
    },
    items,
    total: items.length,
  };
}

// Obtiene la receta de un producto
router.get("/:productId", authMiddleware, async (req, res) => {
  try {
    const { productId } = req.params;

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ ok: false, error: "Producto no existe" });
    }

    const response = await loadRecipeForProduct(product);
    return res.json(response);
  } catch (error) {
    console.error("Error al obtener receta:", error.message);
    return res.status(500).json({ ok: false, error: "Error al obtener receta" });
  }
});

// Define la ruta para establecer la receta completa de un producto
router.put("/:productId", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { productId } = req.params;
    const payload = req.body || {};

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ ok: false, error: "Producto no existe" });
    }

    const items = Array.isArray(payload.items) ? payload.items : [];

    if (!items.length) {
      await ProductRecipe.deleteMany({ product: product._id });
      const response = await loadRecipeForProduct(product);
      return res.json(response);
    }

    const validRole = (r) => ["BASE", "ACCOMP"].includes(String(r || "").toUpperCase());
    const seenIngredients = new Set();
    const normalized = [];
    const ingredientIds = new Set();

    for (const it of items) {
      const ingIdRaw = it.ingredientId || it.ingredient_id;
      const ingId = ingIdRaw ? String(ingIdRaw) : "";

      const qty = Number(it.qty);
      const role = String(it.role || "").toUpperCase();
      const unit = it.unit ? String(it.unit).toUpperCase() : null;
      const note =
        it.note && typeof it.note === "string"
          ? it.note.slice(0, 160)
          : null;

      if (!ingId || ingId === String(product.id)) {
        return res.status(400).json({ ok: false, error: "Ingrediente inválido" });
      }

      if (!(qty > 0)) {
        return res.status(400).json({ ok: false, error: "Cantidad inválida" });
      }

      if (!validRole(role)) {
        return res
          .status(400)
          .json({ ok: false, error: "role inválido (BASE|ACCOMP)" });
      }

      if (seenIngredients.has(ingId)) {
        return res.status(400).json({ ok: false, error: "Ingrediente duplicado" });
      }

      seenIngredients.add(ingId);
      ingredientIds.add(ingId);

      normalized.push({
        ingredientId: ingId,
        qty,
        role,
        unit,
        note,
      });
    }

    const ingProducts = await Product.find({
      _id: { $in: Array.from(ingredientIds) },
    });

    const ingMap = new Map(ingProducts.map((p) => [String(p.id), p]));

    for (const row of normalized) {
      const ingProd = ingMap.get(row.ingredientId);
      if (!ingProd) {
        return res
          .status(400)
          .json({ ok: false, error: `Ingrediente ${row.ingredientId} no existe` });
      }

      const ingType = String(ingProd.inv_type || "UNIT").toUpperCase();

      if (row.role === "BASE" && ingType !== "BASE") {
        return res.status(400).json({
          ok: false,
          error: `Ingrediente ${row.ingredientId} debe ser de tipo BASE`,
        });
      }

      if (row.role === "ACCOMP" && ingType !== "ACCOMP") {
        return res.status(400).json({
          ok: false,
          error: `Ingrediente ${row.ingredientId} debe ser de tipo ACCOMP`,
        });
      }

      if (row.role === "BASE") {
        const u = row.unit || "ML";
        if (!VOL_TO_ML[u]) {
          return res.status(400).json({
            ok: false,
            error: `Unidad inválida para BASE: ${u}`,
          });
        }
      } else {
        const canon =
          String(ingProd.measure || "").toUpperCase() || "UNIT";
        const cat = measureCategory(canon);

        if (cat === "UNIT") {
          const u = (row.unit || "UNIT").toUpperCase();
          if (u !== "UNIT") {
            return res.status(400).json({
              ok: false,
              error: `Acompañamiento ${ingProd.name} usa UNIT`,
            });
          }
          if (Math.round(row.qty) !== row.qty) {
            return res.status(400).json({
              ok: false,
              error: "ACCOMP UNIT requiere enteros",
            });
          }
        } else if (cat === "VOLUME") {
          const u = (row.unit || "ML").toUpperCase();
          if (!VOL_TO_ML[u]) {
            return res.status(400).json({
              ok: false,
              error: `Unidad inválida para ACCOMP volumen: ${u}`,
            });
          }
        } else if (cat === "MASS") {
          const u = (row.unit || "G").toUpperCase();
          if (!MASS_TO_G[u]) {
            return res.status(400).json({
              ok: false,
              error: `Unidad inválida para ACCOMP masa: ${u}`,
            });
          }
        } else {
          return res.status(400).json({
            ok: false,
            error: "Medida del acompañamiento no soportada",
          });
        }
      }
    }

    await ProductRecipe.deleteMany({ product: product._id });

    const docs = normalized.map((row) => ({
      product: product._id,
      ingredient: ingMap.get(row.ingredientId)._id,
      qty: row.qty,
      role: row.role,
      unit: row.unit ? row.unit.slice(0, 16) : null,
      note: row.note,
    }));

    if (docs.length > 0) {
      await ProductRecipe.insertMany(docs);
    }

    const response = await loadRecipeForProduct(product);
    return res.json(response);
  } catch (error) {
    console.error("Error al establecer receta:", error.message);
    return res.status(500).json({ ok: false, error: "Error al establecer receta" });
  }
});

// Exporta el router configurado para recetas
module.exports = {
  recipesRouter: router,
};

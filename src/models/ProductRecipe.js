const mongoose = require("mongoose");

// Define el esquema de receta con referencia al producto y a su ingrediente
const productRecipeSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    ingredient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    qty: {
      type: Number,
      required: true,
      min: 0,
    },
    role: {
      type: String,
      default: null,
      trim: true,
    },
    unit: {
      type: String,
      default: null,
      trim: true,
    },
    note: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
  }
);

// Define índices para optimizar consultas y garantizar unicidad por producto e ingrediente
productRecipeSchema.index({ product: 1, ingredient: 1 }, { unique: true });
productRecipeSchema.index({ product: 1 });
productRecipeSchema.index({ ingredient: 1 });

// Configura la salida JSON para normalizar el identificador y ocultar campos internos
productRecipeSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

// Crea y exporta el modelo ProductRecipe basado en el esquema definido
const ProductRecipe = mongoose.model("ProductRecipe", productRecipeSchema);

module.exports = ProductRecipe;

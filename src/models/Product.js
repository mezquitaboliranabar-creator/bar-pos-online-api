const mongoose = require("mongoose");

// Esquema de producto con campos básicos y de inventario
const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: { type: String, default: "", trim: true },

    price: { type: Number, default: 0 },
    stock: { type: Number, default: 0 },
    min_stock: { type: Number, default: 0 },

    is_active: { type: Boolean, default: true },

    kind: {
      type: String,
      enum: ["STANDARD", "BASE", "ACCOMP", "COCKTAIL"],
      default: "STANDARD",
    },

    inv_type: {
      type: String,
      enum: ["UNIT", "BASE", "ACCOMP"],
      default: "UNIT",
    },

    measure: {
      type: String,
      default: "UNIT",
    },
  },
  {
    timestamps: true,
  }
);

// Normaliza valores antes de guardar el producto
ProductSchema.pre("save", function () {
  if (!this.kind) this.kind = "STANDARD";
  if (!this.inv_type) this.inv_type = "UNIT";
  if (!this.measure) this.measure = "UNIT";

  this.kind = String(this.kind).toUpperCase();
  this.inv_type = String(this.inv_type).toUpperCase();
  this.measure = String(this.measure).toUpperCase();

  if (!Number.isFinite(this.price)) this.price = 0;
  if (!Number.isFinite(this.stock)) this.stock = 0;
  if (!Number.isFinite(this.min_stock)) this.min_stock = 0;
});

// Exporta el modelo de producto
const Product = mongoose.model("Product", ProductSchema);
module.exports = Product;

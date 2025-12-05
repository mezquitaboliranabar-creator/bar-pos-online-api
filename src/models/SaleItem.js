const mongoose = require("mongoose");

// Define el esquema de ítem de venta con referencia a venta y producto
const saleItemSchema = new mongoose.Schema(
  {
    sale: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sale",
      required: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    qty: {
      type: Number,
      required: true,
      min: 1,
    },
    unit_price: {
      type: Number,
      required: true,
      min: 0,
    },
    line_discount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    tax_rate: {
      type: Number,
      default: null,
    },
    tax_amount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    line_total: {
      type: Number,
      required: true,
      min: 0,
    },
    name_snapshot: {
      type: String,
      required: true,
      trim: true,
    },
    category_snapshot: {
      type: String,
      default: null,
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

// Define índices para optimizar consultas por venta y producto
saleItemSchema.index({ sale: 1 });
saleItemSchema.index({ product: 1 });

// Configura la salida JSON para normalizar el identificador y ocultar campos internos
saleItemSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

// Crea y exporta el modelo SaleItem basado en el esquema definido
const SaleItem = mongoose.model("SaleItem", saleItemSchema);

module.exports = SaleItem;

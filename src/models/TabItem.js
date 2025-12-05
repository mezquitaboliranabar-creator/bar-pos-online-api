const mongoose = require("mongoose");

// Define el esquema de ítem de mesa con referencias a la mesa y al producto
const tabItemSchema = new mongoose.Schema(
  {
    tab: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tab",
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
    added_at: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
  },
  {
    timestamps: {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
  }
);

// Define índices para optimizar consultas por mesa y producto
tabItemSchema.index({ tab: 1 });
tabItemSchema.index({ product: 1 });
tabItemSchema.index({ added_at: -1 });

// Configura la salida JSON para normalizar el identificador y ocultar campos internos
tabItemSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

// Crea y exporta el modelo TabItem basado en el esquema definido
const TabItem = mongoose.model("TabItem", tabItemSchema);

module.exports = TabItem;

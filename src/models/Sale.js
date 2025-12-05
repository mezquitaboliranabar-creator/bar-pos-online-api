const mongoose = require("mongoose");

// Define el esquema de venta con los campos principales de la transacción
const saleSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["COMPLETED", "VOIDED", "PARTIAL_REFUND", "REFUNDED"],
      required: true,
      default: "COMPLETED",
    },
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    discount_total: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    tax_total: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    notes: {
      type: String,
      default: null,
      trim: true,
    },
    client: {
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

// Configura la salida JSON para normalizar el identificador y ocultar campos internos
saleSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

// Crea y exporta el modelo Sale basado en el esquema definido
const Sale = mongoose.model("Sale", saleSchema);

module.exports = Sale;

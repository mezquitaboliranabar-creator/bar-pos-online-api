const mongoose = require("mongoose");

// Define el esquema de pago con referencia a la venta y datos del pago
const paymentSchema = new mongoose.Schema(
  {
    sale: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sale",
      required: true,
    },
    method: {
      type: String,
      enum: ["CASH", "CARD", "TRANSFER", "OTHER"],
      required: true,
    },
    provider: {
      type: String,
      enum: ["NEQUI", "DAVIPLATA", null],
      default: null,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    change_given: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    reference: {
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

// Define índices para optimizar consultas por venta y método de pago
paymentSchema.index({ sale: 1 });
paymentSchema.index({ method: 1 });

// Configura la salida JSON para normalizar el identificador y ocultar campos internos
paymentSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

// Crea y exporta el modelo Payment basado en el esquema definido
const Payment = mongoose.model("Payment", paymentSchema);

module.exports = Payment;

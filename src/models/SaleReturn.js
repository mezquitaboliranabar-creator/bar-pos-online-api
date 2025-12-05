const mongoose = require("mongoose");

// Define el esquema de devolución con referencia a venta e ítem de venta
const saleReturnSchema = new mongoose.Schema(
  {
    sale: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sale",
      required: true,
    },
    sale_item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SaleItem",
      required: true,
    },
    qty: {
      type: Number,
      required: true,
      min: 1,
    },
    refund_amount: {
      type: Number,
      required: true,
      min: 0,
    },
    note: {
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

// Define índices para optimizar consultas por venta e ítem de venta
saleReturnSchema.index({ sale: 1 });
saleReturnSchema.index({ sale_item: 1 });

// Configura la salida JSON para normalizar el identificador y ocultar campos internos
saleReturnSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

// Crea y exporta el modelo SaleReturn basado en el esquema definido
const SaleReturn = mongoose.model("SaleReturn", saleReturnSchema);

module.exports = SaleReturn;

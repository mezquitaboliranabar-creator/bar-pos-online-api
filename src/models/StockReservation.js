const mongoose = require("mongoose");

// Define el esquema de reserva de stock por mesa y producto
const stockReservationSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    tab: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tab",
      required: true,
    },
    qty: {
      type: Number,
      required: true,
      min: 1,
    },
    reserved_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    consumed: {
      type: Boolean,
      required: true,
      default: false,
    },
    consumed_at: {
      type: Date,
      default: null,
    },
    sourceRef: {
      type: String,
      default: null,
      trim: true,
    },
    expires_at: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
  }
);

// Define índices para optimizar consultas por producto, mesa y estado
stockReservationSchema.index({ product: 1, tab: 1, consumed: 1 });
stockReservationSchema.index({ tab: 1 });
stockReservationSchema.index({ consumed: 1 });
stockReservationSchema.index({ expires_at: 1 });

// Configura la salida JSON para normalizar el identificador y ocultar campos internos
stockReservationSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

// Crea y exporta el modelo StockReservation basado en el esquema definido
const StockReservation = mongoose.model("StockReservation", stockReservationSchema);

module.exports = StockReservation;

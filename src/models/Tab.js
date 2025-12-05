const mongoose = require("mongoose");

// Define el esquema de mesa con campos principales de estado y metadatos
const tabSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["OPEN", "CLOSED"],
      required: true,
      default: "OPEN",
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    notes: {
      type: String,
      default: null,
      trim: true,
    },
    opened_at: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    closed_at: {
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

// Define índices para optimizar consultas por estado y fecha de apertura
tabSchema.index({ status: 1 });
tabSchema.index({ opened_at: -1 });

// Configura la salida JSON para normalizar el identificador y ocultar campos internos
tabSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

// Crea y exporta el modelo Tab basado en el esquema definido
const Tab = mongoose.model("Tab", tabSchema);

module.exports = Tab;

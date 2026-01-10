const mongoose = require("mongoose");

// Define el esquema de gasto para registrar egresos manuales
const expenseSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    concept: {
      type: String,
      required: true,
      trim: true,
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
    category: {
      type: String,
      default: null,
      trim: true,
    },
    note: {
      type: String,
      default: null,
      trim: true,
    },
    status: {
      type: String,
      enum: ["ACTIVE", "VOID"],
      required: true,
      default: "ACTIVE",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    voidedAt: {
      type: Date,
      default: null,
    },
    voidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    voidReason: {
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
expenseSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

// Crea y exporta el modelo Expense basado en el esquema definido
const Expense = mongoose.model("Expense", expenseSchema);

module.exports = Expense;

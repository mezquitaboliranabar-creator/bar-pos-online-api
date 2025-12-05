const mongoose = require("mongoose");

// Define el esquema de movimiento de inventario con campos clave del flujo de stock
const inventoryMoveSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    qty: {
      type: Number,
      required: true,
    },
    note: {
      type: String,
      default: "",
      trim: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    type: {
      type: String,
      default: null,
      trim: true,
    },
    sourceRef: {
      type: String,
      default: null,
      trim: true,
    },
    location: {
      type: String,
      default: null,
      trim: true,
    },
    supplierId: {
      type: Number,
      default: null,
    },
    supplierName: {
      type: String,
      default: null,
      trim: true,
    },
    invoiceNumber: {
      type: String,
      default: null,
      trim: true,
    },
    unitCost: {
      type: Number,
      default: null,
      min: 0,
    },
    discount: {
      type: Number,
      default: null,
      min: 0,
    },
    tax: {
      type: Number,
      default: null,
      min: 0,
    },
    lot: {
      type: String,
      default: null,
      trim: true,
    },
    expiryDate: {
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

// Define índices para optimizar consultas por producto, fechas, usuario y proveedor
inventoryMoveSchema.index({ product: 1 });
inventoryMoveSchema.index({ createdAt: -1 });
inventoryMoveSchema.index({ user: 1 });
inventoryMoveSchema.index({ supplierId: 1 });
inventoryMoveSchema.index({ type: 1 });
inventoryMoveSchema.index({ location: 1 });

// Configura la salida JSON para normalizar el identificador y ocultar campos internos
inventoryMoveSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

// Crea y exporta el modelo InventoryMove basado en el esquema definido
const InventoryMove = mongoose.model("InventoryMove", inventoryMoveSchema);

module.exports = InventoryMove;

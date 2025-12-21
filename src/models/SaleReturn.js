const mongoose = require("mongoose");

/* Items devueltos (nuevo esquema) */
const saleReturnItemSchema = new mongoose.Schema(
  {
    sale_item_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SaleItem",
      default: null,
    },
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },
    name_snapshot: {
      type: String,
      default: null,
      trim: true,
    },
    qty: {
      type: Number,
      required: true,
      min: 1,
    },
    unit_total: {
      type: Number,
      default: 0,
      min: 0,
    },
    amount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false }
);

/* Define el esquema de devolución (compatible con legacy y nuevo) */
const saleReturnSchema = new mongoose.Schema(
  {
    sale: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sale",
      required: true,
    },

    /* Nuevo formato */
    items: {
      type: [saleReturnItemSchema],
      default: [],
    },
    amount: {
      type: Number,
      default: 0,
      min: 0,
    },
    record_refund_payment: {
      type: Boolean,
      default: false,
    },

    note: {
      type: String,
      default: null,
      trim: true,
    },

    /* Campos legacy (ya no requeridos) */
    sale_item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SaleItem",
      default: null,
    },
    qty: {
      type: Number,
      default: 0,
      min: 0,
    },
    refund_amount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
  }
);

/* Índices */
saleReturnSchema.index({ sale: 1 });
saleReturnSchema.index({ sale_item: 1 });
saleReturnSchema.index({ "items.sale_item_id": 1 });

/* Normaliza salida JSON */
saleReturnSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

/* Modelo */
const SaleReturn = mongoose.model("SaleReturn", saleReturnSchema);

module.exports = SaleReturn;

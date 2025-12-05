const mongoose = require("mongoose");

// Define el esquema de usuario con campos básicos y restricciones
const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    role: {
      type: String,
      required: true,
      enum: ["admin", "vendedor"],
    },
    pinHash: {
      type: String,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
  }
);

// Configura la salida JSON para ocultar campos internos y sensibles
userSchema.set("toJSON", {
  transform(_doc, ret) {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.pinHash;
    return ret;
  },
});

// Crea y exporta el modelo User basado en el esquema definido
const User = mongoose.model("User", userSchema);

module.exports = User;

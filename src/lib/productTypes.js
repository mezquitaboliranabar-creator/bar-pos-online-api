// Define el conjunto de tipos de producto permitidos
const ALLOWED_KINDS = new Set(["STANDARD", "ACCOMP", "BASE", "COCKTAIL"]);

// Normaliza el tipo de producto (kind) a un valor permitido
function normalizeKind(input) {
  const k = String(input ?? "STANDARD").trim().toUpperCase();
  return ALLOWED_KINDS.has(k) ? k : "STANDARD";
}

// Convierte inv_type del front a kind interno
function mapInvTypeToKind(invType) {
  const x = String(invType ?? "UNIT").trim().toUpperCase();
  if (x === "UNIT") return "STANDARD";
  if (x === "BASE") return "BASE";
  if (x === "ACCOMP") return "ACCOMP";
  if (x === "COCKTAIL") return "COCKTAIL";
  return "STANDARD";
}

// Convierte kind interno a inv_type para el front
function mapKindToInvType(kind) {
  const x = String(kind ?? "STANDARD").trim().toUpperCase();
  if (x === "STANDARD") return "UNIT";
  if (x === "BASE") return "BASE";
  if (x === "ACCOMP") return "ACCOMP";
  if (x === "COCKTAIL") return "COCKTAIL";
  return "UNIT";
}

// Normaliza la medida según el tipo de producto
function normalizeMeasureForKind(kind, incomingMeasure) {
  const k = String(kind || "STANDARD").toUpperCase();
  const m =
    incomingMeasure == null
      ? null
      : String(incomingMeasure).toUpperCase().trim();

  if (k === "BASE") return "ML";
  if (k === "ACCOMP") {
    if (!m) return "UNIT";
    if (m === "UNIT" || m === "ML" || m === "G") return m;
    return "UNIT";
  }
  return m || null;
}

// Exporta los helpers de tipos y medidas de producto
module.exports = {
  ALLOWED_KINDS,
  normalizeKind,
  mapInvTypeToKind,
  mapKindToInvType,
  normalizeMeasureForKind,
};

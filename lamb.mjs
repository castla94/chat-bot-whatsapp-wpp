
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand
} from "@aws-sdk/client-dynamodb";

// ==========================================
// CONFIGURACION
// ==========================================

const SHEET_ID =
  "1EhGL30R8wgYD85QB49Cqbdx_6p0XSwjRV9eScIZRq0Q";

const SHEET_GID = process.env.SHEET_GID || "68254101";

const TABLE_NAME = "whatsapp_prompt";
const PK_NAME = "email";
const PK_VALUE = "sepriovitalca@gmail.com";

const MAX_MARKDOWN_BYTES = 350000;

// Estructura del markdown
const PRODUCT_COLUMN = "Producto"; // columna 2: producto (agrupación)
const MODEL_COLUMN = "Modelo"; // columna 3: modelo (agrupación)
const COLOR_COLUMN = "Color";
const SIZE_COLUMN = "Talla";
const STOCK_COLUMN = "Disponible";
const LINK_COLUMN =
  "Imagen referencial del producto (enlace de WhatsApp)";
const SKIP_COLUMN = "SKU"; // columna 1: no se lee
const IGNORED_COLUMNS = ["Descripción del producto"]; // columnas que no se muestran

// Etiquetas legibles para los encabezados de la hoja
const HEADER_LABELS = {
  "Precio divisas (USD)": "Precio en divisas",
  "Precio a tasa BCV (ref. USD)": "Precio normal en dólares"
};

// Valores vacíos o de marcador que no deben aparecer
const PLACEHOLDERS = [
  "no registra informacion",
  "sin informacion",
  "no aplica",
  "n/a",
  "na",
  "-"
];

const dynamodb = new DynamoDBClient({});

// ==========================================
// UTILIDADES
// ==========================================

function clean(value) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlaceholder(value) {
  return PLACEHOLDERS.includes(
    clean(value).toLowerCase()
  );
}

function response(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(data)
  };
}

// ==========================================
// LEER CSV DE GOOGLE SHEETS
// ==========================================

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, "");

  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }

      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (quoted) {
    throw new Error("CSV inválido");
  }

  if (row.length || field !== "") {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// ==========================================
// OBTENER HEADERS Y FILAS DE LA HOJA
// ==========================================

async function getSheetData() {
  const url =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "text/csv"
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!res.ok) {
    throw new Error(
      `Google Sheets HTTP ${res.status}`
    );
  }

  const csv = await res.text();

  if (
    csv.length > 5000000 ||
    /<html|<!doctype html/i.test(
      csv.slice(0, 500)
    )
  ) {
    throw new Error(
      "Google Sheets no devolvió CSV válido"
    );
  }

  const table = parseCSV(csv).filter(row =>
    row.some(cell => clean(cell) !== "")
  );

  if (table.length < 2) {
    throw new Error(
      "Google Sheets vacío o sin filas de datos"
    );
  }

  const headers = table[0].map(header =>
    clean(header)
  );

  const rows = table.slice(1).map(row => {
    const item = {};

    headers.forEach((header, index) => {
      item[header] = clean(row[index]);
    });

    return item;
  });

  console.log(
    "Headers Google Sheets:",
    JSON.stringify(headers)
  );

  console.log(
    "Filas Google Sheets:",
    rows.length
  );

  return { headers, rows };
}

// ==========================================
// GENERAR STRING MARKDOWN
// ==========================================

// Primer valor no vacío de una columna
function firstValue(rows, column) {
  for (const row of rows) {
    const value = row[column];

    if (value && !isPlaceholder(value))
      return value;
  }

  return "";
}

function buildMarkdown(headers, rows) {
  // Agrupar por Producto (columna B) y Modelo (columna C)
  const groups = new Map();

  // Columnas que no se listan como datos simples
  const structuralColumns = new Set([
    PRODUCT_COLUMN,
    MODEL_COLUMN,
    COLOR_COLUMN,
    SIZE_COLUMN,
    STOCK_COLUMN,
    LINK_COLUMN,
    SKIP_COLUMN,
    ...IGNORED_COLUMNS
  ]);

  for (const row of rows) {
    const product =
      row[PRODUCT_COLUMN] || "SIN PRODUCTO";

    const model =
      row[MODEL_COLUMN] || "";

    if (!groups.has(product))
      groups.set(product, new Map());

    const models = groups.get(product);

    if (!models.has(model))
      models.set(model, []);

    models.get(model).push(row);
  }

  const lines = [
    "## INFORMACIÓN DEL CATÁLOGO",
    "",
    "- Los datos provienen del inventario en Google Sheets.",
    "- No inventar productos, precios ni características.",
    "- «Precio en divisas»: aplica a Binance y a dólares en efectivo; no se indica en bolívares.",
    "- «Precio normal en dólares»: aplica a Pago Móvil y Transferencia.",
    ""
  ];

  for (
    const product of [...groups.keys()]
      .sort((a, b) => a.localeCompare(b, "es"))
  ) {
    lines.push(`## ${product}`, "");

    const models = groups.get(product);

    for (
      const model of [...models.keys()]
        .sort((a, b) => a.localeCompare(b, "es"))
    ) {
      const items = models.get(model);

      // Solo se crea el subtítulo cuando hay modelo;
      // si no, la ficha queda bajo el producto.
      if (model)
        lines.push(`### ${model}`);

      // Disponibilidad desglosada por color y talla
      const stock = new Map();

      for (const row of items) {
        const color =
          row[COLOR_COLUMN] || "Sin color";

        if (!stock.has(color))
          stock.set(color, []);

        stock.get(color).push({
          size: row[SIZE_COLUMN] || "",
          qty: row[STOCK_COLUMN] || "0"
        });
      }

      if (stock.size) {
        lines.push(
          "- Disponibilidad (color/talla):"
        );

        for (
          const color of [...stock.keys()]
            .sort((a, b) =>
              a.localeCompare(b, "es")
            )
        ) {
          const entries = stock
            .get(color)
            .sort((a, b) =>
              a.size.localeCompare(b.size, "es", {
                numeric: true
              })
            )
            .map(entry =>
              entry.size
                ? `${entry.size} (${entry.qty})`
                : entry.qty
            );

          lines.push(
            `  - ${color}: ${entries.join(", ")}`
          );
        }
      }

      // Enlaces por color (cada modelo+color con su link,
      // dentro de una sola ficha de producto + modelo)
      const linksByColor = new Map();

      for (const row of items) {
        const link = row[LINK_COLUMN];

        if (!link || isPlaceholder(link))
          continue;

        const color = row[COLOR_COLUMN] || "";

        if (!linksByColor.has(color))
          linksByColor.set(color, new Set());

        linksByColor.get(color).add(link);
      }

      if (linksByColor.size) {
        // Sin variantes de color: link directo
        if (linksByColor.size === 1 && linksByColor.has("")) {
          lines.push(
            `- imagen: ${[...linksByColor.get("")].join(" | ")}`
          );
        } else {
          lines.push("- imagen:");

          for (
            const color of [...linksByColor.keys()]
              .sort((a, b) =>
                a.localeCompare(b, "es")
              )
          ) {
            lines.push(
              `  - ${color || model || product}: ${[...linksByColor.get(color)].join(" | ")}`
            );
          }
        }
      }

      // Datos compartidos del modelo
      for (const header of headers) {
        if (structuralColumns.has(header))
          continue;

        const value = firstValue(
          items,
          header
        );

        if (!value)
          continue;

        const label =
          HEADER_LABELS[header] || header;

        lines.push(`- ${label}: ${value}`);
      }

      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

// ==========================================
// DYNAMODB GETITEM
// ==========================================

async function getPromptItem() {
  const data = await dynamodb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        [PK_NAME]: { S: PK_VALUE }
      },
      ConsistentRead: true
    })
  );

  if (!data.Item) {
    throw new Error(
      `No existe ${PK_VALUE} en ${TABLE_NAME}`
    );
  }

  return data.Item;
}

// ==========================================
// DYNAMODB UPDATE SOLO PRODUCTS
// ==========================================

async function updateProducts(markdown) {
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        [PK_NAME]: { S: PK_VALUE }
      },
      UpdateExpression:
        "SET #products = :value",
      ConditionExpression:
        "attribute_exists(#pk)",
      ExpressionAttributeNames: {
        "#products": "products",
        "#pk": PK_NAME
      },
      ExpressionAttributeValues: {
        ":value": { S: markdown }
      },
      ReturnValues: "NONE"
    })
  );
}

// ==========================================
// LAMBDA HANDLER
// ==========================================

export const handler = async (
  event = {},
  context
) => {
  try {
    const input =
      typeof event.body === "string"
        ? JSON.parse(event.body || "{}")
        : event.body &&
          typeof event.body === "object"
          ? event.body
          : event;

    const dryRun = input?.dryRun === true;

    console.log(
      "Iniciando sincronización desde Google Sheets"
    );

    // 1. VERIFICAR REGISTRO

    await getPromptItem();

    // 2. LEER HEADERS Y FILAS DE GOOGLE SHEETS

    const { headers, rows } =
      await getSheetData();

    if (!rows.length) {
      throw new Error(
        "Google Sheets sin filas de datos"
      );
    }

    // 3. GENERAR MARKDOWN

    const markdown = buildMarkdown(
      headers,
      rows
    );

    const bytes = Buffer.byteLength(
      markdown,
      "utf8"
    );

    // 4. IMPRIMIR RESULTADO EN LOGS

    console.log("Markdown generado:");
    console.log(markdown);

    console.log({
      total_filas: rows.length,
      markdown_bytes: bytes
    });

    // 5. VALIDAR TAMAÑO

    if (bytes > MAX_MARKDOWN_BYTES) {
      throw new Error(
        `Markdown demasiado grande: ${bytes} bytes`
      );
    }

    // 6. MODO PRUEBA

    if (dryRun) {
      return response(200, {
        success: true,
        dryRun: true,
        total_filas: rows.length,
        markdown_bytes: bytes,
        preview: markdown.slice(0, 10000)
      });
    }

    // 7. ACTUALIZAR SOLO PRODUCTS

    await updateProducts(markdown);

    return response(200, {
      success: true,
      table: TABLE_NAME,
      pk: PK_VALUE,
      updated_field: "products",
      total_filas: rows.length,
      markdown_bytes: bytes,
      message:
        "Catálogo actualizado correctamente"
    });

  } catch (error) {
    console.error(error);

    return response(500, {
      success: false,
      table: TABLE_NAME,
      pk: PK_VALUE,
      updated_field: "products",
      message:
        "No fue posible completar la sincronización",
      error: error.message
    });
  }
};

import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const dynamoDBClient = new DynamoDBClient({ region: "us-east-1" });

const WHATSAPP_TABLE = String(process.env.WHATSAPP_CONVERSATION_TABLE || "whatsapp_conversation").trim();
const INSTAGRAM_TABLE = String(process.env.INSTAGRAM_CHAT_TABLE || "instagram_chat").trim();
const MESSENGER_TABLE = String(process.env.MESSENGER_CHAT_TABLE || "messenger_chat").trim();
const INSTAGRAM_SESSIONS_TABLE = String(process.env.INSTAGRAM_SESSIONS_TABLE || "instagram_sessions").trim();
const MESSENGER_SESSIONS_TABLE = String(process.env.MESSENGER_SESSIONS_TABLE || "messenger_sessions").trim();
const WIDGET_GUESTS_TABLE = String(process.env.WIDGET_GUESTS_TABLE || "chatbot-widget-guests").trim();
const WIDGET_MESSAGES_TABLE = String(process.env.WIDGET_MESSAGES_TABLE || "chatbot-widget-messages").trim();

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,OPTIONS"
  },
  body: JSON.stringify(body)
});

const getFirstString = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

const isMissingKeySchemaElementError = (error, keyName) =>
  String(error?.message || "").includes(`Query condition missed key schema element: ${keyName}`);

const queryAllByEmail = async ({ tableName, email, maxItems, dateRange }) => {
  let startKey = undefined;
  let collected = [];
  try {
    while (true) {
      const params = {
        TableName: tableName,
        KeyConditionExpression: "#email = :email",
        ExpressionAttributeNames: { "#email": "email" },
        ExpressionAttributeValues: { ":email": { S: email } },
        ExclusiveStartKey: startKey,
        Limit: 200
      };
      // Filtra el mes en DynamoDB para no traer todo el histórico (evita el 413).
      if (dateRange) {
        params.FilterExpression = "#ts BETWEEN :rangeStart AND :rangeEnd";
        params.ExpressionAttributeNames["#ts"] = dateRange.attribute;
        params.ExpressionAttributeValues[":rangeStart"] = { S: dateRange.startIso };
        params.ExpressionAttributeValues[":rangeEnd"] = { S: dateRange.endIso };
      }
      const res = await dynamoDBClient.send(new QueryCommand(params));
      const items = Array.isArray(res?.Items) ? res.Items.map((i) => unmarshall(i)) : [];
      collected = collected.concat(items);
      if (collected.length > maxItems) {
        console.error("Consulta por email superó el máximo de items", {
          tableName,
          email,
          maxItems,
          collected: collected.length,
          monthScoped: Boolean(dateRange)
        });
        return { ok: false, error: "TOO_MANY_ITEMS", items: [] };
      }
      startKey = res?.LastEvaluatedKey;
      if (!startKey) break;
    }
  } catch (error) {
    console.error("Error consultando tabla por email", {
      tableName,
      email,
      message: error?.message || String(error)
    });
    throw error;
  }
  return { ok: true, items: collected };
};

const queryAllBySenderId = async ({ tableName, senderId, email, maxItems, dateRange }) => {
  let startKey = undefined;
  let collected = [];
  try {
    while (true) {
      const expressionNames = {
        "#senderId": "senderId",
        "#email": "email"
      };
      const expressionValues = {
        ":senderId": { S: senderId },
        ":email": { S: email }
      };
      // `timestamp` es la sort key de la tabla: el rango temporal debe ir en la
      // KeyConditionExpression (DynamoDB no permite keys en el FilterExpression).
      let keyConditionExpression = "#senderId = :senderId";
      const filterExpression = "#email = :email";
      // Filtra el mes en DynamoDB para no traer todo el histórico (evita el 413).
      if (dateRange) {
        keyConditionExpression += " AND #ts BETWEEN :rangeStart AND :rangeEnd";
        expressionNames["#ts"] = dateRange.attribute;
        expressionValues[":rangeStart"] = { S: dateRange.startIso };
        expressionValues[":rangeEnd"] = { S: dateRange.endIso };
      }
      const res = await dynamoDBClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: keyConditionExpression,
          FilterExpression: filterExpression,
          ExpressionAttributeNames: expressionNames,
          ExpressionAttributeValues: expressionValues,
          ExclusiveStartKey: startKey,
          Limit: 200
        })
      );
      const items = Array.isArray(res?.Items) ? res.Items.map((i) => unmarshall(i)) : [];
      collected = collected.concat(items);
      if (collected.length > maxItems) {
        console.error("Consulta por senderId superó el máximo de items", {
          tableName,
          senderId,
          email,
          maxItems,
          collected: collected.length,
          monthScoped: Boolean(dateRange)
        });
        return { ok: false, error: "TOO_MANY_ITEMS", items: [] };
      }
      startKey = res?.LastEvaluatedKey;
      if (!startKey) break;
    }
  } catch (error) {
    console.error("Error consultando tabla por senderId", {
      tableName,
      senderId,
      email,
      message: error?.message || String(error)
    });
    throw error;
  }
  return { ok: true, items: collected };
};

const queryWidgetMessagesBySessionIdAndCreatedAt = async ({ sessionId, startIso, endIso, maxItems }) => {
  if (!WIDGET_MESSAGES_TABLE) return { ok: true, items: [] };
  let startKey = undefined;
  let collected = [];
  try {
    while (true) {
      const res = await dynamoDBClient.send(
        new QueryCommand({
          TableName: WIDGET_MESSAGES_TABLE,
          KeyConditionExpression: "#sessionId = :sessionId",
          FilterExpression: "#createdAt BETWEEN :start AND :end",
          ExpressionAttributeNames: { "#sessionId": "session_id", "#createdAt": "created_at", "#role": "role" },
          ExpressionAttributeValues: { ":sessionId": { S: sessionId }, ":start": { S: startIso }, ":end": { S: endIso } },
          ProjectionExpression: "#createdAt, guest_id, #role",
          ExclusiveStartKey: startKey,
          Limit: 200
        })
      );
      const items = Array.isArray(res?.Items) ? res.Items.map((i) => unmarshall(i)) : [];
      collected = collected.concat(items);
      if (collected.length > maxItems) return { ok: false, error: "TOO_MANY_ITEMS", items: [] };
      startKey = res?.LastEvaluatedKey;
      if (!startKey) break;
    }
  } catch (error) {
    console.error("Error consultando mensajes web por session_id", {
      tableName: WIDGET_MESSAGES_TABLE,
      sessionId,
      startIso,
      endIso,
      message: error?.message || String(error)
    });
    throw error;
  }

  return { ok: true, items: collected };
};

export const handler = async (event) => {
  const method = String(event?.requestContext?.http?.method || event?.httpMethod || "").toUpperCase();
  if (method === "OPTIONS") return response(204, "");

  const emailRaw = String(event?.queryStringParameters?.email || "").trim().toLowerCase();
  if (!emailRaw) return response(400, { ok: false, error: "MISSING_EMAIL" });
  const debug = String(event?.queryStringParameters?.debug || "").trim() === "1";

  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    // Rango del mes actual para filtrar en DynamoDB (los timestamps se guardan en ISO UTC).
    const monthRange = {
      attribute: "timestamp",
      startIso: startOfMonth.toISOString(),
      endIso: endOfMonth.toISOString()
    };

    const chartData = Array.from({ length: daysInMonth }, (_, i) => ({
      dia: String(i + 1).padStart(2, "0"),
      mensajes: 0,
      usuariosActivos: 0,
      mensajesWhatsapp: 0,
      usuariosWhatsapp: 0,
      mensajesInstagram: 0,
      usuariosInstagram: 0,
      mensajesMessenger: 0,
      usuariosMessenger: 0,
      mensajesWeb: 0,
      usuariosWeb: 0
    }));

    const uniqueWhatsappUsersByDay = new Array(daysInMonth).fill(null).map(() => new Set());
    const uniqueInstagramUsersByDay = new Array(daysInMonth).fill(null).map(() => new Set());
    const uniqueMessengerUsersByDay = new Array(daysInMonth).fill(null).map(() => new Set());
    const uniqueWebUsersByDay = new Array(daysInMonth).fill(null).map(() => new Set());

    const whatsappMonthUsers = new Set();
    const instagramMonthUsers = new Set();
    const messengerMonthUsers = new Set();

    let whatsappMessages = 0;
    let instagramMessages = 0;
    let messengerMessages = 0;

    if (WHATSAPP_TABLE) {
      const waRes = await queryAllByEmail({
        tableName: WHATSAPP_TABLE,
        email: emailRaw,
        maxItems: 20000,
        dateRange: monthRange
      });
      if (!waRes.ok) return response(413, { ok: false, error: waRes.error });
      for (const item of waRes.items) {
        const ts = getFirstString(item, ["timestamp", "created_at", "time"]);
        const phoneRaw = getFirstString(item, ["phone", "from", "number"]);
        if (!ts || !phoneRaw) continue;
        const dt = new Date(ts);
        if (dt < startOfMonth || dt > endOfMonth) continue;
        const dayIndex = dt.getDate() - 1;
        if (dayIndex < 0 || dayIndex >= daysInMonth) continue;
        whatsappMessages += 1;
        chartData[dayIndex].mensajes += 1;
        chartData[dayIndex].mensajesWhatsapp += 1;
        const phone = String(phoneRaw).split("_")[0] || phoneRaw;
        if (phone) whatsappMonthUsers.add(phone);
        if (phone && !uniqueWhatsappUsersByDay[dayIndex].has(phone)) {
          uniqueWhatsappUsersByDay[dayIndex].add(phone);
          chartData[dayIndex].usuariosActivos += 1;
          chartData[dayIndex].usuariosWhatsapp += 1;
        }
      }
    }

    if (INSTAGRAM_TABLE) {
      const instagramSessionsRes = await queryAllByEmail({
        tableName: INSTAGRAM_SESSIONS_TABLE,
        email: emailRaw,
        maxItems: 5000,
        dateRange: monthRange
      });
      if (!instagramSessionsRes.ok) return response(413, { ok: false, error: instagramSessionsRes.error });

      const instagramSenderIds = [
        ...new Set(
          instagramSessionsRes.items
            .map((item) => getFirstString(item, ["senderId", "sender_id", "from", "user_id", "uid"]))
            .filter(Boolean)
        )
      ];

      for (const senderId of instagramSenderIds) {
        const igRes = await queryAllBySenderId({
          tableName: INSTAGRAM_TABLE,
          senderId,
          email: emailRaw,
          maxItems: 2000,
          dateRange: monthRange
        });
        if (!igRes.ok) return response(413, { ok: false, error: igRes.error });
        for (const item of igRes.items) {
        const ts = getFirstString(item, ["timestamp", "created_at", "time"]);
        if (!ts || !senderId) continue;
        const dt = new Date(ts);
        if (dt < startOfMonth || dt > endOfMonth) continue;
        const dayIndex = dt.getDate() - 1;
        if (dayIndex < 0 || dayIndex >= daysInMonth) continue;
        instagramMessages += 1;
        chartData[dayIndex].mensajes += 1;
        chartData[dayIndex].mensajesInstagram += 1;
        instagramMonthUsers.add(senderId);
        if (!uniqueInstagramUsersByDay[dayIndex].has(senderId)) {
          uniqueInstagramUsersByDay[dayIndex].add(senderId);
          chartData[dayIndex].usuariosActivos += 1;
          chartData[dayIndex].usuariosInstagram += 1;
        }
      }
      }
    }

    if (MESSENGER_TABLE) {
      const messengerSessionsRes = await queryAllByEmail({
        tableName: MESSENGER_SESSIONS_TABLE,
        email: emailRaw,
        maxItems: 5000,
        dateRange: monthRange
      });
      if (!messengerSessionsRes.ok) return response(413, { ok: false, error: messengerSessionsRes.error });

      const messengerSenderIds = [
        ...new Set(
          messengerSessionsRes.items
            .map((item) => getFirstString(item, ["senderId", "sender_id", "from", "user_id", "uid"]))
            .filter(Boolean)
        )
      ];

      for (const senderId of messengerSenderIds) {
        const messengerRes = await queryAllBySenderId({
          tableName: MESSENGER_TABLE,
          senderId,
          email: emailRaw,
          maxItems: 2000,
          dateRange: monthRange
        });
        if (!messengerRes.ok) return response(413, { ok: false, error: messengerRes.error });
        for (const item of messengerRes.items) {
        const ts = getFirstString(item, ["timestamp", "created_at", "time"]);
        if (!ts || !senderId) continue;
        const dt = new Date(ts);
        if (dt < startOfMonth || dt > endOfMonth) continue;
        const dayIndex = dt.getDate() - 1;
        if (dayIndex < 0 || dayIndex >= daysInMonth) continue;
        messengerMessages += 1;
        chartData[dayIndex].mensajes += 1;
        chartData[dayIndex].mensajesMessenger += 1;
        messengerMonthUsers.add(senderId);
        if (!uniqueMessengerUsersByDay[dayIndex].has(senderId)) {
          uniqueMessengerUsersByDay[dayIndex].add(senderId);
          chartData[dayIndex].usuariosActivos += 1;
          chartData[dayIndex].usuariosMessenger += 1;
        }
      }
      }
    }

    let webUsers = 0;
    let webMessages = 0;
    let webMessagesMonthItemsCount = 0;
    let webSessionIds = [];

    if (WIDGET_GUESTS_TABLE) {
        try {
          const guestsRes = await queryAllByEmail({ tableName: WIDGET_GUESTS_TABLE, email: emailRaw, maxItems: 5000 });
          if (guestsRes.ok) {
            const uniqueGuests = new Set();
            const debugMeta = debug ? { guests_total: guestsRes.items.length, guests_with_guest_id: 0 } : null;
            for (const g of guestsRes.items) {
              const guestId = getFirstString(g, ["guest_id"]);
              if (!guestId) continue;
              if (debugMeta) debugMeta.guests_with_guest_id += 1;
              uniqueGuests.add(guestId);
            }
            webSessionIds = [
              ...new Set(
                guestsRes.items
                  .map((item) => getFirstString(item, ["session_id", "sessionId"]))
                  .filter(Boolean)
              )
            ];
            webUsers = uniqueGuests.size;
            if (debugMeta) {
              webUsers = uniqueGuests.size;
              if (!event.__debug_meta) event.__debug_meta = {};
              event.__debug_meta.web_guests = debugMeta;
              event.__debug_meta.web_sessions = { session_ids: webSessionIds.length };
            }
        }
        } catch (error) {
          console.error("No se pudo calcular webUsers desde widget guests", {
            tableName: WIDGET_GUESTS_TABLE,
            email: emailRaw,
            message: error?.message || String(error)
          });
          if (!isMissingKeySchemaElementError(error, "email") && !isMissingKeySchemaElementError(error, "session_id")) {
            throw error;
          }
      }
    }

    if (WIDGET_MESSAGES_TABLE) {
      const startIso = startOfMonth.toISOString();
      const endIso = endOfMonth.toISOString();
        try {
          if (!webSessionIds.length) {
            console.error("No se encontraron session_id para consultar widget messages", {
              tableName: WIDGET_MESSAGES_TABLE,
              email: emailRaw
            });
          } else {
            for (const sessionId of webSessionIds) {
              const webMsgRes = await queryWidgetMessagesBySessionIdAndCreatedAt({
                sessionId,
                startIso,
                endIso,
                maxItems: 5000
              });
              if (!webMsgRes.ok) return response(413, { ok: false, error: webMsgRes.error });
              webMessagesMonthItemsCount += webMsgRes.items.length;
              for (const m of webMsgRes.items) {
                const createdAt = getFirstString(m, ["created_at"]);
                if (!createdAt) continue;
                const dt = new Date(createdAt);
                if (dt < startOfMonth || dt > endOfMonth) continue;
                const dayIndex = dt.getDate() - 1;
                if (dayIndex < 0 || dayIndex >= daysInMonth) continue;
                webMessages += 1;
                chartData[dayIndex].mensajes += 1;
                chartData[dayIndex].mensajesWeb += 1;

                const role = getFirstString(m, ["role"]);
                if (role !== "user") continue;
                const gid = getFirstString(m, ["guest_id"]);
                if (!gid) continue;
                if (!uniqueWebUsersByDay[dayIndex].has(gid)) {
                  uniqueWebUsersByDay[dayIndex].add(gid);
                  chartData[dayIndex].usuariosActivos += 1;
                  chartData[dayIndex].usuariosWeb += 1;
                }
              }
            }
        }
        } catch (error) {
          console.error("No se pudo calcular webMessages desde widget messages", {
            tableName: WIDGET_MESSAGES_TABLE,
            email: emailRaw,
            startIso,
            endIso,
            message: error?.message || String(error)
          });
          if (!isMissingKeySchemaElementError(error, "email") && !isMissingKeySchemaElementError(error, "session_id")) {
            throw error;
          }
      }
    }

    return response(200, {
      ok: true,
      whatsappUsers: whatsappMonthUsers.size,
      whatsappMessages,
      instagramUsers: instagramMonthUsers.size,
      instagramMessages,
      messengerUsers: messengerMonthUsers.size,
      messengerMessages,
      webUsers,
      webMessages,
      chartData,
      ...(debug
        ? {
            debug: {
              ...(event.__debug_meta || {}),
              web_messages_query: { items: webMessagesMonthItemsCount }
            }
          }
        : {})
    });
  } catch (error) {
      console.error("Error generando reporte de metricas", {
        email: emailRaw,
        message: error?.message || String(error)
      });
    return response(500, { ok: false, error: "INTERNAL_ERROR", detail: String(error?.message || "Unknown error") });
  }
};

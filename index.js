import express from "express";
import crypto from "crypto";

const app = express();

// Slack envia slash command como x-www-form-urlencoded
app.use(
  express.urlencoded({
    extended: true,
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    }
  })
);

const PORT = process.env.PORT || 3000;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function verifySlackSignature(req) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSignature = req.headers["x-slack-signature"];

  if (!timestamp || !slackSignature || !req.rawBody) {
    return false;
  }

  // evita replay muito antigo
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - (60 * 5);
  if (Number(timestamp) < fiveMinutesAgo) {
    return false;
  }

  const sigBaseString = `v0:${timestamp}:${req.rawBody}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", SLACK_SIGNING_SECRET)
      .update(sigBaseString, "utf8")
      .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature, "utf8"),
      Buffer.from(slackSignature, "utf8")
    );
  } catch {
    return false;
  }
}

async function apagarMensagem(channel, ts) {
  const res = await fetch("https://slack.com/api/chat.delete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({ channel, ts })
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") || 5);
    console.log(`Rate limit ao apagar. Esperando ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return apagarMensagem(channel, ts);
  }

  const data = await res.json();

  if (!data.ok) {
    if (data.error === "cant_delete_message") {
      console.log(`Sem permissão para apagar ${ts}`);
      return false;
    }

    if (data.error === "ratelimited") {
      console.log("Rate limited no body. Esperando 5s...");
      await sleep(5000);
      return apagarMensagem(channel, ts);
    }

    console.log(`Erro ao apagar ${ts}: ${data.error}`);
    return false;
  }

  console.log(`Apagada ${ts}`);
  return true;
}

async function limparCanal(channel) {
  let cursor;
  let hasMore = true;
  let apagadas = 0;
  let ignoradas = 0;

  while (hasMore) {
    const payload = {
      channel,
      limit: 100
    };

    if (cursor) {
      payload.cursor = cursor;
    }

    const res = await fetch("https://slack.com/api/conversations.history", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(payload)
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") || 5);
      console.log(`Rate limit ao listar. Esperando ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      continue;
    }

    const data = await res.json();

    if (!data.ok) {
      throw new Error(`Erro no conversations.history: ${data.error}`);
    }

    for (const msg of data.messages || []) {
      if (!msg.ts) continue;

      const ok = await apagarMensagem(channel, msg.ts);
      if (ok) apagadas++;
      else ignoradas++;

      await sleep(400);
    }

    hasMore = data.has_more === true;
    cursor = data.response_metadata?.next_cursor || undefined;
  }

  console.log(`Finalizado. Apagadas: ${apagadas}. Ignoradas: ${ignoradas}.`);
}

app.get("/", (req, res) => {
  res.status(200).send("Slack cleaner online");
});

app.post("/slack/limparcanal", async (req, res) => {
  if (!verifySlackSignature(req)) {
    return res.status(401).send("Assinatura inválida.");
  }

  const channelId = req.body.channel_id;
  const channelName = req.body.channel_name;

  // responder rápido para o Slack
  res.status(200).send(`Recebi o comando. Tentando limpar #${channelName}...`);

  // processa depois da resposta
  try {
    await limparCanal(channelId);
  } catch (error) {
    console.error("Erro geral:", error.message);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
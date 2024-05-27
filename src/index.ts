import { AdaptiveCards } from "@microsoft/adaptivecards-tools";
import notificationTemplate from "./adaptiveCards/notification-default.json";
import { notificationApp } from "./internal/initialize";
import { CardData } from "./cardModels";
import {createEventSource, type EventSourceClient} from 'eventsource-client';
import { Issuer } from 'openid-client';
import dotenv from 'dotenv';
import { TeamsBot } from "./teamsBot";
import * as restify from 'restify';

// Notification priorities
const notificationPrioritiesNO = {
  "low": "Lav",
  "medium": "Medium",
  "high": "Høy"
}

// Application modules
const modulesNO = {
  "Economy": "Økonomi",
  "Budgeting": "Budsjett",
  "Invoices": "Fakturering",
  "DepositsAndLoans": "Inn- og utlån",
  "HRM": "HRM",
  "Procurement": "eHandel",
  "InvoiceProcessing": "Fakturabehandling",
  "DvPro": "Drift & Vedlikehold",
  "System": "System"
}

// Load environment variables from .env file
dotenv.config();

// Retrieve environment variable for Notifications API Base URL
const baseUrl: string = process.env.BASE_URL;

// Inactivity timeout in ms before reconnecting to the notification stream
const timeout: number = 60000;

// Timeout object for reconnecting to the notification stream
let timeoutId: NodeJS.Timeout;

// Event Source client
let es: EventSourceClient;

// Create HTTP server.
const server = restify.createServer();
server.use(restify.plugins.bodyParser());
server.listen(process.env.port || process.env.PORT || 3978, () => {
  console.log(`\nApp Started, ${server.name} listening to ${server.url}`);
});

/**
 * Sends a notification to one or more Teams users
 * @param data - data from a notification event from the notification stream
 * @param id - id from the notification event
 */
async function sendNotification(data: string, id: string): Promise<void> {
  const payload = JSON.parse(data)?.payload;
  const receivers = payload?.receivers;

  if (!receivers) {
    console.log(`No receivers found in payload for event ID ${id}`);
    return;
  }

  for(const receiver of receivers) {
    const member = await notificationApp.notification.findMember(
      async (m) => m.account.userPrincipalName?.toLowerCase().localeCompare(receiver.email?.toLowerCase()) === 0
    );

    if(!member) {
      console.log(`User ${receiver.email} not found`);
      continue;
    }

    console.log(`Sending notification for event ID ${id} to ${receiver.email}`);

    const dateTimeFormatOptions: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    };

    await member.sendAdaptiveCard(
      AdaptiveCards.declare<CardData>(notificationTemplate).render({
        title: payload.title,
        subtitle: `${modulesNO[payload.module]}`,
        description: payload.message,
        dateCreated: new Date(payload.created + 'Z').toLocaleString("nb-NO", dateTimeFormatOptions),
        priority: notificationPrioritiesNO[payload.priority],
        notificationUrl: payload.url || baseUrl,
      })
    );
  }
}

/**
 * Retrieves an access token for the notification stream using client credentials flow
 * .env file must contain variables BASE_URL, AUTHZ_CLIENT_ID and AUTHZ_CLIENT_SECRET
 * @returns Bearer access token
 */
async function getAccessToken() {
  const authzIssuer = new Issuer({
    issuer: `${baseUrl}/authz/api`,
    token_endpoint: `${baseUrl}/authz/api/oauth/token`,
    jwks_uri: `${baseUrl}/authz/api/.well-known/openid-configuration/jwks`
  });

  const client = new authzIssuer.Client({
    client_id: process.env.AUTHZ_CLIENT_ID,
    client_secret: process.env.AUTHZ_CLIENT_SECRET,
  });

  const tokenSet = await client.grant({
    grant_type: 'client_credentials'
  });

  return tokenSet.access_token;
}

/**
 * Starts a connection to the SSE notification stream and sends incoming notifications to Teams users
 */
async function getNotificationEventClient(): Promise<EventSourceClient> {
  const notificationUrl = `${baseUrl}/notifications/external/api/v1/sse`;
  return createEventSource({
    url: notificationUrl,
    headers: {Authorization: `Bearer ${await getAccessToken()}`},

    onConnect: () => {
      console.log(`Connected to notification stream - URL ${notificationUrl}`);
    },
    onDisconnect: () => {
      console.log(`Disconnected from notification stream - URL ${notificationUrl}`);
    },
    onMessage: ({data, event, id}) => {
      if (event === 'notification' && id) {
        console.log(`Notification event ID ${id} - Data: ${data}`);
        sendNotification(data, id);
        resetTimer();
      }
      else if (event === 'health') {
        console.log(`Health event: ${data}`);
        resetTimer();
      }
      else {
        console.log(`${event} event ID ${id} - Data: ${data}`);
      }
    }
  })
}

/**
 * Reset the timer when the application starts or when an event is received
 */
function resetTimer() {
  if(timeoutId) {
    clearTimeout(timeoutId);
  }
  timeoutId = setTimeout(reconnect, timeout);
}

/**
 * Reconnect to the notification stream if the timer expires
 */
function reconnect() {
  console.log(`Reconnecting to notification stream after ${timeout} ms of inactivity`)
  resetNotificationStream();
  resetTimer();
}

/**
 * Close any existing notifications stream and start a new one, and a new timer
 */
async function resetNotificationStream() {
  es?.close();
  es = await getNotificationEventClient();
  resetTimer();
}

resetNotificationStream();

// Bot Framework message handler.
const teamsBot = new TeamsBot();
server.post("/api/messages", async (req, res) => {
  await notificationApp.requestHandler(req, res, async (context) => {
    await teamsBot.run(context);
  });
});

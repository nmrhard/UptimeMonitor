const Fastify = require('fastify');
const { Sequelize, DataTypes } = require('sequelize');
const dotenv = require('dotenv');
const joi = require('joi');
const fetch = require('node-fetch');
const cron = require('node-cron');
const ping = require('ping');
const cors = require('@fastify/cors');

// Load environment variables
dotenv.config();

const app = Fastify({ logger: true });
const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS, 10) || 5000;

app.register(cors, {
  origin: '*', // Allow all origins (for development)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Allowed HTTP methods
});

// Database connection
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: process.env.DB_FILE || './monitor.db',
  logging: false, // Disable SQL query logging for security and cleaner logs
});

// Import Models
const Monitor = require('./models/monitor')(sequelize, DataTypes);
const MonitorLog = require('./models/monitorLog')(sequelize, DataTypes);

// Sync database
(async () => {
  try {
    await sequelize.sync();
    app.log.info('Database synchronized.');
  } catch (error) {
    app.log.error(`Database synchronization failed: ${error.message}`);
    process.exit(1);
  }
})();

// Validation schema
const monitorSchema = joi.object({
  ipOrUrl: joi.alternatives().try(
    joi
      .string()
      .ip({ version: ['ipv4', 'ipv6'] })
      .required(), // Validates IP addresses (IPv4 and IPv6)
    joi.string().uri().required() // Validates URLs
  ),
  webhookUrl: joi.string().uri().optional(), // Optional webhook URL
});

// Add Monitor Endpoint
app.post('/add-monitor', async (req, reply) => {
  const { error, value } = monitorSchema.validate(req.body);

  if (error) {
    return reply.status(400).send({ error: error.details[0].message });
  }

  try {
    // Check if the monitor already exists
    const existingMonitor = await Monitor.findOne({
      where: { ipOrUrl: value.ipOrUrl },
    });

    if (existingMonitor) {
      await Monitor.update(
        { ipOrUrl: value.ipOrUrl },
        { where: { id: existingMonitor.id } }
      );
      return reply.send({
        success: true,
        message: `Monitor updated for ${value.ipOrUrl}`,
      });
    }

    // Create the new monitor
    await Monitor.create({ ipOrUrl: value.ipOrUrl });
    reply.send({
      success: true,
      message: `Monitor added for ${value.ipOrUrl}`,
    });
  } catch (err) {
    // Log the error for debugging
    app.log.error(`Failed to add monitor: ${err.message}`);
    reply.status(500).send({ error: 'Failed to add monitor.' });
  }
});

// Add Webhook Endpoint
app.post('/add-webhook', async (req, reply) => {
  const { error, value } = monitorSchema.validate(req.body);

  if (error) {
    return reply.status(400).send({ error: error.details[0].message });
  }

  try {
    const monitor = await Monitor.findOne({
      where: { ipOrUrl: value.ipOrUrl },
    });

    if (!monitor) {
      return reply
        .status(404)
        .send({ error: `Monitor with IP/URL ${value.ipOrUrl} not found.` });
    }

    // Update the webhook URL
    await monitor.update({ webhookUrl: value.webhookUrl });

    reply.send({
      success: true,
      message: `Webhook URL updated for ${value.ipOrUrl}`,
    });
  } catch (err) {
    app.log.error(`Failed to update webhook URL: ${err.message}`);
    reply.status(500).send({ error: 'Failed to update webhook URL.' });
  }
});

// View Logs Endpoint
app.get('/logs', async (req, reply) => {
  try {
    const logs = await MonitorLog.findAll({ order: [['createdAt', 'DESC']] });
    reply.send(logs);
  } catch (err) {
    reply.status(500).send({ error: 'Failed to fetch logs.' });
  }
});

app.delete('/delete-all-monitors', async (req, reply) => {
  await Monitor.destroy({ where: {} });
  await MonitorLog.destroy({ where: {} });
  reply.send({ success: true, message: 'All monitors deleted.' });
});

function checkIpAddress(ipOrUrl) {
  return /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(
    ipOrUrl
  );
}

// Monitoring Logic with Timeout
async function checkStatus(monitor) {
  const isIpAddress = checkIpAddress(monitor.ipOrUrl);

  if (isIpAddress) {
    // Use ping for IP address reachability
    try {
      const res = await ping.promise.probe(monitor.ipOrUrl, {
        timeout: TIMEOUT_MS / 1000,
      });
      return res.alive ? 'online' : 'offline';
    } catch (error) {
      return 'offline'; // Return offline if ping fails
    }
  } else {
    // Use fetch for URL (HTTP/S check)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(monitor.ipOrUrl, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok ? 'online' : 'offline';
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        return 'offline'; // Return offline if request is aborted
      }
      throw error;
    }
  }
}

async function updateMonitorStatus(monitor, status) {
  await MonitorLog.create({ ipOrUrl: monitor.ipOrUrl, status });
  await monitor.update({ lastStatus: status, lastChecked: new Date() });
  app.log.info(`${monitor.ipOrUrl} is now ${status}`);
}

async function sendWebhook(monitor, status) {
  if (!monitor.webhookUrl) return;

  try {
    await fetch(monitor.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monitor_status: status,
        timestamp: Math.floor(Date.now() / 1000),
      }),
    });
    app.log.info(
      `Webhook sent to ${monitor.webhookUrl} for ${monitor.ipOrUrl}`
    );
  } catch (err) {
    app.log.error(
      `Failed to send webhook to ${monitor.webhookUrl}: ${err.message}`
    );
  }
}

async function handleMonitor(monitor) {
  try {
    const status = await checkStatus(monitor);

    if (status !== monitor.lastStatus) {
      await updateMonitorStatus(monitor, status);
      await sendWebhook(monitor, status);
    }
  } catch (error) {
    app.log.error(`Error checking ${monitor.ipOrUrl}: ${error.message}`);
  }
}

async function checkMonitors() {
  const monitors = await Monitor.findAll();
  await Promise.all(monitors.map(handleMonitor));
}

// Schedule Monitoring
cron.schedule('* * * * *', checkMonitors); // Run every minute

// Start Server
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Server running on port ${PORT}`);
});

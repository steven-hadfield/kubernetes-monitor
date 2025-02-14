import fsExtra = require('fs-extra');

import * as SourceMapSupport from 'source-map-support';

import { state } from './state';
import { config } from './common/config';
import { logger } from './common/logger';
import { currentClusterName } from './supervisor/cluster';
import { beginWatchingWorkloads } from './supervisor/watchers';
import { loadAndSendWorkloadEventsPolicy } from './common/policy';
import { sendClusterMetadata } from './transmitter';
import { setSnykMonitorAgentId } from './supervisor/agent';
import { scrapeData, scrapeDataV1 } from './data-scraper';
import { getSysdigVersion, setupHealthCheck, sysdigV1 } from './healthcheck';

process.on('uncaughtException', (error) => {
  if (state.shutdownInProgress) {
    return;
  }

  try {
    logger.error({ error }, 'UNCAUGHT EXCEPTION!');
  } catch (ignore) {
    console.log('UNCAUGHT EXCEPTION!', error);
  } finally {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  if (state.shutdownInProgress) {
    return;
  }

  try {
    logger.error({ reason, promise }, 'UNHANDLED REJECTION!');
  } catch (ignore) {
    console.log('UNHANDLED REJECTION!', reason, promise);
  } finally {
    process.exit(1);
  }
});

function cleanUpTempStorage() {
  const { IMAGE_STORAGE_ROOT } = config;
  try {
    fsExtra.emptyDirSync(IMAGE_STORAGE_ROOT);
    logger.info({}, 'Cleaned temp storage');
  } catch (err) {
    logger.error({ err }, 'Error deleting files');
  }
}

async function monitor(): Promise<void> {
  try {
    logger.info(
      {
        cluster: currentClusterName,
        useKeepalive: config.USE_KEEPALIVE,
      },
      'starting to monitor',
    );
    await beginWatchingWorkloads();
  } catch (error) {
    logger.error({ error }, 'an error occurred while monitoring the cluster');
    process.exit(1);
  }
}

async function setupSysdigIntegration(): Promise<void> {
  if (
    !(
      config.SYSDIG_REGION_URL &&
      config.SYSDIG_RISK_SPOTLIGHT_TOKEN &&
      config.SYSDIG_CLUSTER_NAME
    ) ||
    !(config.SYSDIG_ENDPOINT && config.SYSDIG_TOKEN)
  ) {
    console.log('Sysdig integration not enabled');
    return;
  }

  let sysdigVersion = getSysdigVersion();
  logger.info({}, `Sysdig ${sysdigVersion} data scraping starting`);

  const initialInterval: number = 60 * 1000; // 20 mins in milliseconds
  setTimeout(async () => {
    try {
      if (sysdigVersion == sysdigV1) {
        await scrapeDataV1();
      } else {
        await scrapeData();
      }
    } catch (error) {
      logger.error(
        { error },
        'an error occurred while scraping initial runtime data',
      );
    }
  }, initialInterval).unref();

  const interval: number = 4 * 60 * 60 * 1000; // 4 hours in milliseconds
  setInterval(async () => {
    try {
      if (sysdigVersion == sysdigV1) {
        await scrapeDataV1();
      } else {
        await scrapeData();
      }
    } catch (error) {
      logger.error({ error }, 'an error occurred while scraping runtime data');
    }
  }, interval).unref();
}

SourceMapSupport.install();
cleanUpTempStorage();

// Allow running in an async context
setImmediate(async function setUpAndMonitor(): Promise<void> {
  await setSnykMonitorAgentId();
  await sendClusterMetadata();
  await loadAndSendWorkloadEventsPolicy();
  await monitor();
  await setupSysdigIntegration();
  await setupHealthCheck();
});

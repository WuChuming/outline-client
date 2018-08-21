// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as net from 'net';
import * as sudo from 'sudo-prompt';

import * as errors from '../www/model/errors';

const SERVICE_PIPE_NAME = 'OutlineServicePipe';
const SERVICE_PIPE_PATH = '\\\\.\\pipe\\';
const SERVICE_START_COMMAND = 'net start OutlineService';

interface RoutingServiceRequest {
  action: string;
  parameters: {[parameter: string]: string};
}

interface RoutingServiceResponse {
  // 0 iff the operation was successful.
  statusCode: number;
  errorMessage?: string;
}

export interface RoutingService {
  configureRouting(routerIp: string, proxyIp: string): Promise<void>;
  resetRouting(): Promise<void>;
}

enum RoutingServiceAction {
  CONFIGURE_ROUTING = 'configureRouting',
  RESET_ROUTING = 'resetRouting'
}

// Define the error type thrown by the net module.
interface NetError extends Error {
  code?: string|number;
  errno?: string;
  syscall?: string;
  address?: string;
}

// Abstracts IPC with OutlineService in order to configure routing.
export class WindowsRoutingService implements RoutingService {
  private ipcConnection: net.Socket;

  // Asks OutlineService to configure all traffic, except that bound for the proxy server,
  // to route via routerIp.
  configureRouting(routerIp: string, proxyIp: string): Promise<void> {
    return this.sendRequest({
      action: RoutingServiceAction.CONFIGURE_ROUTING,
      parameters: {
        proxyIp,
        routerIp,
      }
    });
  }

  // Restores the default system routes.
  resetRouting(): Promise<void> {
    return this.sendRequest({action: RoutingServiceAction.RESET_ROUTING, parameters: {}});
  }

  // Helper method to perform IPC with the Windows Service. Prompts the user for admin permissions
  // to start the service, in the event that it is not running.
  // TODO: rejects are crazy here
  private sendRequest(request: RoutingServiceRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ipcConnection = net.createConnection(`${SERVICE_PIPE_PATH}${SERVICE_PIPE_NAME}`, () => {
        console.log('Pipe connected');
        try {
          const msg = JSON.stringify(request);
          this.ipcConnection.write(msg);
        } catch (e) {
          reject(new Error(`Failed to serialize JSON request: ${e.message}`));
        }
      });

      this.ipcConnection.on('error', (err) => {
        const netErr = err as NetError;
        if (netErr.errno === 'ENOENT') {
          console.info(`Routing service not running. Attempting to start.`);
          // Prompt the user for admin permissions to start the routing service.
          sudo.exec(SERVICE_START_COMMAND, {name: 'Outline'}, (sudoError, stdout, stderr) => {
            if (sudoError) {
              console.error(`could not start routing service: ${sudoError}`);
              return reject(new errors.NoAdminPermissions());
            }
            return this.sendRequest(request).then(resolve, reject);
          });
        } else {
          reject(new Error(`Received error from service connection: ${netErr.message}`));
        }
      });

      this.ipcConnection.on('data', (data) => {
        console.log('Got data from pipe');
        if (data) {
          try {
            const response = JSON.parse(data.toString());
            if (response.statusCode !== 0) {
              console.error(`OutlineService says: ${response.errorMessage}`);
              reject(new errors.ConfigureSystemProxyFailure());
            }
            resolve(response);
          } catch (e) {
            reject(new Error(`Failed to deserialize service response: ${e.message}`));
          }
        } else {
          reject(new Error('Failed to receive data form routing service'));
        }
        try {
          this.ipcConnection.destroy();
        } catch (e) {
          // Don't reject, the service may have disconnected the pipe already.
        }
      });
    });
  }
}

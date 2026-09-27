// Identity + router bindings: auth, users, backends.
import { AccessAuthService } from '@edge-sonic/backend-services/auth';
import { BackendService } from '@edge-sonic/backend-services/router';
import { UserService } from '@edge-sonic/backend-services/user';
import type { Container } from '@edge-sonic/backend-runtime/di';
import { Tokens } from '../tokens';
import { createService } from '../serviceFactory';
import type { ServiceGroupContext } from './daoThunks';

function bindCoreServices(scope: Container, { env, daos }: ServiceGroupContext): void {
  scope.bind(Tokens.AccessAuthService, () => createService(AccessAuthService, env));
  scope.bind(Tokens.UserService, () =>
    createService(UserService, env, {
      userDAO: daos.userDAO,
    }),
  );
  scope.bind(Tokens.BackendService, () =>
    createService(BackendService, env, {
      backendDAO: daos.routerBackendDAO,
    }),
  );
}

export { bindCoreServices };

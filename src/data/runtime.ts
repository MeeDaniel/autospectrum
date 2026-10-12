import { adminProvider as demoAdminProvider, provider as demoProvider, RevisionConflictError, ScheduleConflictError, SubmissionRejectedError } from './demo';
import { createApiProviders } from './api';

const api = createApiProviders();
const useDemo = import.meta.env.DEV || import.meta.env.VITE_DEMO_MODE === 'true';
export const demoMode = useDemo;
export const provider = useDemo ? demoProvider : api.provider;
export const adminProvider = useDemo ? demoAdminProvider : api.adminProvider;
export const auth = api.auth;
export const listAudit = api.listAudit;
export { RevisionConflictError, ScheduleConflictError, SubmissionRejectedError };

import type { AddonSDK } from '../../../../services/AddonsSDK';
import type {
  DistributionJobRecord,
  DistributionRecipient,
  AirdropWorkspace,
  EventBackendHealth,
} from '../types';

function normalizeBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, '');
}

export function createDistributorApi(sdk: AddonSDK, apiBaseUrl: string) {
  const baseUrl = normalizeBaseUrl(apiBaseUrl);

  return {
    async getHealth(): Promise<EventBackendHealth> {
      return await sdk.http.fetchJson<EventBackendHealth>(`${baseUrl}/health`);
    },

    async listWorkspaces(): Promise<AirdropWorkspace[]> {
      const response = await sdk.http.fetchJson<{ workspaces: AirdropWorkspace[] }>(
        `${baseUrl}/admin/workspaces`
      );
      return response.workspaces || [];
    },

    async listRecipients(workspaceId: string): Promise<DistributionRecipient[]> {
      const response = await sdk.http.fetchJson<{ recipients: DistributionRecipient[] }>(
        `${baseUrl}/admin/workspaces/${encodeURIComponent(workspaceId)}/recipients`
      );
      return response.recipients || [];
    },

    async importRecipients(
      workspaceId: string,
      recipients: Array<{ label?: string; address: string; notes?: string; source?: string }>
    ): Promise<DistributionRecipient[]> {
      const response = await sdk.http.fetchJson<{ recipients: DistributionRecipient[] }>(
        `${baseUrl}/admin/workspaces/${encodeURIComponent(workspaceId)}/recipients/import`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ recipients }),
        }
      );
      return response.recipients || [];
    },

    async importTokenHolders(
      workspaceId: string,
      category: string,
      limit = 100
    ): Promise<DistributionRecipient[]> {
      const response = await sdk.http.fetchJson<{ recipients: DistributionRecipient[] }>(
        `${baseUrl}/admin/workspaces/${encodeURIComponent(
          workspaceId
        )}/recipients/token-holders`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ category, limit }),
        }
      );
      return response.recipients || [];
    },

    async listJobs(workspaceId: string): Promise<DistributionJobRecord[]> {
      const response = await sdk.http.fetchJson<{ jobs: DistributionJobRecord[] }>(
        `${baseUrl}/admin/workspaces/${encodeURIComponent(workspaceId)}/jobs`
      );
      return response.jobs || [];
    },

    async prepareJobs(args: {
      workspaceId: string;
      recipientIds: string[];
      assetType: 'token' | 'bch';
      tokenCategory?: string;
      amount: string;
    }): Promise<DistributionJobRecord[]> {
      const response = await sdk.http.fetchJson<{ jobs: DistributionJobRecord[] }>(
        `${baseUrl}/admin/workspaces/${encodeURIComponent(args.workspaceId)}/jobs/prepare`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            recipient_ids: args.recipientIds,
            asset_type: args.assetType,
            token_category: args.tokenCategory,
            amount: args.amount,
          }),
        }
      );
      return response.jobs || [];
    },

    async completeDistributionJob(args: {
      jobId: string;
      status?: string;
      txid?: string;
    }): Promise<{ job: DistributionJobRecord }> {
      return await sdk.http.fetchJson<{ job: DistributionJobRecord }>(
        `${baseUrl}/distribution/jobs/${encodeURIComponent(args.jobId)}/complete`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            status: args.status || 'sent',
            txid: args.txid,
          }),
        }
      );
    },
  };
}

/**
 * @aws-sdk/credential-providers shim for Databricks.
 * Provides dummy implementations for AWS credential providers since Databricks uses token-based auth.
 */

/**
 * Dummy implementation of fromTemporaryCredentials.
 * Databricks doesn't need AWS credentials, so this returns a no-op provider.
 */
export async function fromTemporaryCredentials(config: any): Promise<any> {
  return {
    resolveAwsCredentials: async () => ({
      accessKeyId: 'dummy',
      secretAccessKey: 'dummy',
      sessionToken: 'dummy',
      expiration: new Date(Date.now() + 3600000), // 1 hour from now
    }),
  };
}

/**
 * Other credential provider functions for AWS SDK compatibility.
 * All return dummy credentials since we use Databricks token-based auth.
 */
export async function defaultProvider(config?: any): Promise<any> {
  return fromTemporaryCredentials(config || {});
}

export const fromEnv = async (): Promise<any> => fromTemporaryCredentials({});
export const fromEC2Metadata = async (): Promise<any> => fromTemporaryCredentials({});
export const fromContainerMetadata = async (): Promise<any> => fromTemporaryCredentials({});

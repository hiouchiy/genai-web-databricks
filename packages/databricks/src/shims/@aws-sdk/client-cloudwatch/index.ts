import { clientWith, command, noopHandlers } from '../../_common/aws';

/** CloudWatch メトリクス → 標準出力ログ（Databricks Apps のログで確認） */
export const PutMetricDataCommand = command('PutMetricData');
export const StandardUnit = new Proxy({} as Record<string, string>, { get: (_t, p) => String(p) });

export const CloudWatchClient = clientWith({
  ...noopHandlers([]),
  PutMetricData: async (i) => {
    console.log(JSON.stringify({ metric: i.Namespace, data: i.MetricData }));
    return {};
  },
});

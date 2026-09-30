import { clientWith, command } from '../../_common/aws';

/** メール送信（パスワードリセット等）は Databricks SSO に集約したためスコープ外 */
export const SendEmailCommand = command('SendEmail');
export const SESv2Client = clientWith({});

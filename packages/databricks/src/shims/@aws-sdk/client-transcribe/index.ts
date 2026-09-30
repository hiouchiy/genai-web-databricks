import { clientWith, command } from '../../_common/aws';

/** 音声文字起こしは今回スコープ外（将来: Whisper on Model Serving） */
export const StartTranscriptionJobCommand = command('StartTranscriptionJob');
export const GetTranscriptionJobCommand = command('GetTranscriptionJob');
export const TranscribeClient = clientWith({});

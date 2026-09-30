import './session';

/** Amplify.configure は不要（Cognito を使わない） */
export const Amplify = {
  configure: (_config?: unknown) => {},
  getConfig: () => ({}),
};
export default { Amplify };

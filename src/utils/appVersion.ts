import packageJson from '../../package.json';

/** Running wallet version from the package manifest compiled into this build. */
export const APP_VERSION: string = packageJson.version;

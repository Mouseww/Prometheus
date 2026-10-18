import type { ConnectorProvider } from "../types.ts";
import { atlassian } from "./atlassian.ts";
import { bitbucket } from "./bitbucket.ts";
import { database } from "./database.ts";
import { github } from "./github.ts";
import { microsoft } from "./microsoft.ts";

/** Add a provider here and it appears in the UI and in the agent tools. */
export const providers: ConnectorProvider[] = [github, atlassian, bitbucket, microsoft, database];

export const providerById = (id: string): ConnectorProvider | undefined => providers.find((p) => p.id === id);

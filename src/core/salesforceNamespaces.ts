/**
 * Namespaces of packages Salesforce itself installs in new orgs. They are hidden from the packages
 * column so it shows only what someone chose to install. Compared without regard to case.
 *
 * The list starts from the packages found in a new plain scratch org and a new Revenue Cloud (RLM)
 * scratch org, read with `sf package installed list -o <org> --json`. Add a namespace only when
 * Salesforce publishes the package; when unsure, leave the package visible.
 */
export const SALESFORCE_NAMESPACES: readonly string[] = [
  'OIQ', // Sales Insights. Seen in a plain scratch org and an RLM scratch org.
];

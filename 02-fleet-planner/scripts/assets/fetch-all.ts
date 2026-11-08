// Fetches every shortlisted source GLB and its license files into the cache, and prints the license check.
// Usage: tsx scripts/assets/fetch-all.ts
import { SHORTLIST } from './shortlist.ts';
import { checkLicense, sourceGlb } from './fetch.ts';

const rows = await Promise.all(
  SHORTLIST.map(async (s) => {
    const buf = await sourceGlb(s.src);
    const lic = await checkLicense(s.src);
    return { ...lic, mb: (buf.byteLength / 1e6).toFixed(2) };
  }),
);
console.table(rows);
if (rows.some((r) => !r.ok)) process.exitCode = 1;

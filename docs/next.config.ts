import type { NextConfig } from "next";
import withMarkdoc from '@markdoc/next.js'
import withSearch from './src/markdoc/search.mjs'

const nextConfig: NextConfig = {
  pageExtensions: ['js', 'jsx', 'md', 'ts', 'tsx'],
}

export default withSearch(
  withMarkdoc({ schemaPath: './src/markdoc' })(nextConfig),
)

// added by create cloudflare to enable calling `getCloudflareContext()` in `next dev`
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare'
initOpenNextCloudflareForDev()

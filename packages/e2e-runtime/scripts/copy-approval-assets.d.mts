export interface CopyApprovalAssetsOptions {
  sourcePackageRoot?: string
  targetRoot?: string
}

export interface CopyApprovalAssetsResult {
  version: '13.3.0'
  sourceDigest: string
  targetDigest: string
  licenseDigest: string
}

export function copyApprovalAssets(options?: CopyApprovalAssetsOptions): Promise<CopyApprovalAssetsResult>

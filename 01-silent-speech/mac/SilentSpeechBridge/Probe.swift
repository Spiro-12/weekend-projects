// Temporary CI probe (removed in the next commit): which SDK and compiler does the Mac CI job have?
#if canImport(FoundationModels)
#warning("probe: FoundationModels is in this SDK")
#else
#warning("probe: no FoundationModels in this SDK")
#endif
#if compiler(>=6.2)
#warning("probe: Swift compiler 6.2 or newer")
#elseif compiler(>=6.0)
#warning("probe: Swift compiler 6.0 or 6.1")
#else
#warning("probe: Swift compiler older than 6.0")
#endif

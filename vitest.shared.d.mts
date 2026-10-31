export declare const SOURCE_CONDITION: '@jantar/source';
export declare function sharedConfig(opts?: { browser?: boolean }): {
  resolve: { conditions: string[] };
  ssr: { resolve: { conditions: string[]; externalConditions: string[] } };
  test: {
    include: string[];
    testTimeout: number;
    hookTimeout: number;
    restoreMocks: boolean;
  };
};

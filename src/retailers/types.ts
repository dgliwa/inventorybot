export type RetailerStorePreference = {
  storeId: string;
  name: string;
  address?: string;
  primary: boolean;
};

export type RetailerSubscription = {
  id: string;
  domain: string;
  postalCode: string;
  radiusMiles: number;
  stores: RetailerStorePreference[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

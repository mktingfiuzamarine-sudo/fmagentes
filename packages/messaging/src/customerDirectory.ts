export interface DirectoryCustomer {
  id: string;
  name: string;
}

/**
 * Read-only view of the CRM that messaging needs to identify a customer before
 * the model runs. Messaging never learns how the CRM is reached.
 */
export interface CustomerDirectoryPort {
  /** null when nobody, or more than one client, matches. */
  findByPhone(phone: string): Promise<DirectoryCustomer | null>;
  findById(id: string): Promise<DirectoryCustomer | null>;
}

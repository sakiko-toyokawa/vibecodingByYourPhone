import type { ProviderDescriptor } from "./descriptor.js";

export class ProviderRegistry {
  private byName = new Map<string, ProviderDescriptor>();
  private descriptors: ProviderDescriptor[] = [];

  register(descriptor: ProviderDescriptor): void {
    this.descriptors.push(descriptor);
    for (const name of descriptor.names) {
      if (this.byName.has(name)) {
        throw new Error(`Provider "${name}" is already registered`);
      }
      this.byName.set(name, descriptor);
    }
  }

  get(name: string): ProviderDescriptor {
    const descriptor = this.byName.get(name);
    if (!descriptor) {
      throw new Error(`Unknown provider: "${name}"`);
    }
    return descriptor;
  }

  getOrNull(name: string): ProviderDescriptor | null {
    return this.byName.get(name) ?? null;
  }

  list(): ProviderDescriptor[] {
    return [...this.descriptors];
  }

  namesByGroup(group: string): string[] {
    const descriptor = this.descriptors.find((d) => d.group === group);
    return descriptor ? [...descriptor.names] : [];
  }

  allNames(): string[] {
    return Array.from(this.byName.keys());
  }

  getByGroup(group: string): ProviderDescriptor | null {
    return this.descriptors.find((d) => d.group === group) ?? null;
  }
}

export const providerRegistry = new ProviderRegistry();

import { loadConfig } from './config';
import { seedProducts } from './seed';
import { createServer } from './server';
import { Service } from './service';
import { Store } from './store';

const config = loadConfig();
const store = new Store(config);
for (const product of seedProducts) store.products.set(product.id, { ...product });

const service = new Service(store);
const port = Number(process.env.PORT ?? 3000);
const server = createServer(service);

server.listen(port, () => {
  console.log(`Checkout service listening on http://localhost:${port}`);
  console.log(
    `Coupon rule: every ${config.n} orders unlock one ${config.x}% coupon ` +
      `(COUPON_EVERY_N_ORDERS / COUPON_PERCENT)`,
  );
});

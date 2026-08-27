
## Recipes, ingredients and stock deduction

Authenticated `owner`/`manager` users can manage the tenant-scoped catalog at
`/api/ingredients` and `/api/recipes`. Ingredient units are `g`, `kg`, `ml`,
`l`, `un` or `unit`; quantities/costs are finite and non-negative (recipe
quantities and yields are strictly positive), and recipe ingredient units must
be compatible with the ingredient unit (mass, volume, or count). A recipe is
one per product and its ingredient list is replaced atomically on update.

When an authenticated staff member changes an order to `delivered`, the API
locks the order, calculates each recipe quantity (`ingredient quantity × sold
quantity ÷ recipe yield`, converting compatible units), locks/deducts stock,
records one `stock_movements` row per ingredient/order, writes the event, and
commits everything as one transaction. Insufficient stock or invalid item
quantity returns `409`/`400` and leaves the order and stock unchanged. A
repeated transition to the same status is idempotent and never deducts twice;
terminal orders cannot be changed. Products without an active recipe do not
consume stock, so existing catalog/orders remain safe until recipes are
configured.

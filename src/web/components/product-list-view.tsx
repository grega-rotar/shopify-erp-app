import {
  useEffect,
  useId,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import {
  defaultDirection,
  moveColumn,
  normalizeColumns,
  PRODUCT_FACETS,
  PRODUCT_SORT_KEYS,
  type ColumnSetting,
  type ProductColumn,
  type ProductFacet,
  type ProductFilters,
  type ProductSort,
  type ProductSortKey,
  type SortDirection,
} from "~/domain/products/product-list";

/**
 * The product list's view controls, the way the admin's own product index
 * has them: a chip per facet that filters by "is any of", and one button
 * that opens sort, hide archived and the columns — each column shown or
 * hidden with its eye, and put in order by dragging its handle (or with the
 * arrow keys on the handle).
 *
 * Built from Polaris pieces only (`s-clickable-chip`, `s-popover`,
 * `s-clickable`, `s-checkbox`, `s-switch`), with no styling of our own. The
 * one plain element is the `div` that carries native drag and drop, which no
 * Polaris component exposes.
 */

export const COLUMN_LABEL: Record<ProductColumn, string> = {
  status: "Status",
  category: "Category",
  productType: "Product type",
  vendor: "Vendor",
  variants: "Variants",
  price: "Price",
  tags: "Tags",
  updated: "Updated",
};

export const SORT_LABEL: Record<ProductSortKey, string> = {
  title: "Product title",
  updated: "Updated",
  productType: "Product type",
  vendor: "Vendor",
  category: "Category",
};

export const FACET_LABEL: Record<ProductFacet, string> = {
  vendor: "Vendor",
  productType: "Product type",
  category: "Category",
  tag: "Tag",
};

function directionLabels(key: ProductSortKey): Record<SortDirection, string> {
  return key === "updated"
    ? { asc: "Oldest first", desc: "Newest first" }
    : { asc: "A–Z", desc: "Z–A" };
}

const COLUMNS_STORAGE_KEY = "recharge-hub:product-list:columns";

/**
 * The viewer's column layout, remembered in their browser. A convenience,
 * not state: storage that is blocked or empty gives the default layout.
 */
export function useProductColumns(): [
  ColumnSetting[],
  (columns: ColumnSetting[]) => void,
] {
  // The server renders the default layout; the stored one is read after
  // hydration so the two renders agree.
  const [columns, setColumns] = useState<ColumnSetting[]>(() =>
    normalizeColumns(null),
  );
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(COLUMNS_STORAGE_KEY);
      if (stored) setColumns(normalizeColumns(JSON.parse(stored) as unknown));
    } catch {
      // Unreadable storage leaves the default layout.
    }
  }, []);
  const save = (next: ColumnSetting[]) => {
    setColumns(next);
    try {
      window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Blocked storage only means the layout is not remembered.
    }
  };
  return [columns, save];
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

/** A list with more values than this gets a search box above it. */
const SEARCHABLE_FROM = 8;

function FacetChip({
  facet,
  options,
  selected,
  onChange,
}: {
  facet: ProductFacet;
  options: readonly string[];
  selected: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const popoverId = `facet-${facet}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [search, setSearch] = useState("");
  const label = FACET_LABEL[facet];
  // A value in the address that the snapshot no longer has stays visible,
  // so it can be unticked.
  const values = [
    ...selected.filter((value) => !options.includes(value)),
    ...options,
  ];
  const needle = search.trim().toLowerCase();
  const shown =
    needle === ""
      ? values
      : values.filter((value) => value.toLowerCase().includes(needle));

  return (
    <>
      <s-clickable-chip
        commandFor={popoverId}
        {...(selected.length > 0 ? { color: "strong" as const } : {})}
        accessibilityLabel={
          selected.length > 0
            ? `${label} is ${selected.join(", ")}`
            : `Filter by ${label.toLowerCase()}`
        }
      >
        {selected.length > 0 ? `${label} is ${selected.join(", ")}` : label}
      </s-clickable-chip>
      <s-popover id={popoverId} maxBlockSize="360px">
        <s-box padding="small-200">
          <s-stack direction="block" gap="small-300">
            {values.length > SEARCHABLE_FROM ? (
              <s-search-field
                label={`Search ${label.toLowerCase()}`}
                labelAccessibilityVisibility="exclusive"
                placeholder={`Search ${label.toLowerCase()}`}
                value={search}
                onInput={(event) => setSearch(event.currentTarget.value)}
              />
            ) : null}
            {shown.length === 0 ? (
              <s-text color="subdued">
                {values.length === 0
                  ? `No product has a ${label.toLowerCase()} yet.`
                  : "Nothing matches."}
              </s-text>
            ) : (
              <s-stack direction="block" gap="small-300">
                {shown.map((value) => (
                  <s-checkbox
                    key={value}
                    label={value}
                    checked={selected.includes(value)}
                    onChange={(event) =>
                      onChange(
                        event.currentTarget.checked
                          ? [...selected, value]
                          : selected.filter((v) => v !== value),
                      )
                    }
                  />
                ))}
              </s-stack>
            )}
            {selected.length > 0 ? (
              <s-stack direction="inline" justifyContent="start">
                <s-button
                  variant="tertiary"
                  command="--hide"
                  commandFor={popoverId}
                  onClick={() => onChange([])}
                >
                  Clear
                </s-button>
              </s-stack>
            ) : null}
          </s-stack>
        </s-box>
      </s-popover>
    </>
  );
}

/** One chip per facet, and a way to clear them all once any is set. */
export function ProductFilterChips({
  filters,
  options,
  onChange,
}: {
  filters: ProductFilters;
  options: ProductFilters;
  onChange: (facet: ProductFacet, values: string[]) => void;
}) {
  const active = PRODUCT_FACETS.filter((facet) => filters[facet].length > 0);
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center">
      {PRODUCT_FACETS.map((facet) => (
        <FacetChip
          key={facet}
          facet={facet}
          options={options[facet]}
          selected={filters[facet]}
          onChange={(values) => onChange(facet, values)}
        />
      ))}
      {active.length > 0 ? (
        <s-button
          variant="tertiary"
          onClick={() => active.forEach((facet) => onChange(facet, []))}
        >
          Clear all
        </s-button>
      ) : null}
    </s-stack>
  );
}

/* -------------------------------------------------------------------------- */
/* Sort, hide archived and columns                                            */
/* -------------------------------------------------------------------------- */

function SortChoice({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <s-clickable
      borderRadius="base"
      paddingInline="small-200"
      paddingBlock="small-400"
      inlineSize="100%"
      onClick={onSelect}
      accessibilityLabel={selected ? `${label}, selected` : label}
    >
      <s-grid
        gridTemplateColumns="1fr auto"
        gap="small-200"
        alignItems="center"
      >
        <s-text>{label}</s-text>
        {selected ? <s-icon type="check" /> : <s-box inlineSize="20px" />}
      </s-grid>
    </s-clickable>
  );
}

export function ProductViewOptions({
  sort,
  onSortChange,
  hideArchived,
  onHideArchivedChange,
  hideArchivedDisabled,
  columns,
  onColumnsChange,
}: {
  sort: ProductSort;
  onSortChange: (sort: ProductSort) => void;
  hideArchived: boolean;
  onHideArchivedChange: (hide: boolean) => void;
  /** True when the status view already decides whether archived shows. */
  hideArchivedDisabled: boolean;
  columns: ColumnSetting[];
  onColumnsChange: (columns: ColumnSetting[]) => void;
}) {
  const popoverId = `view-options-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [sortOpen, setSortOpen] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const directions = directionLabels(sort.key);

  const toggle = (index: number) =>
    onColumnsChange(
      columns.map((column, i) =>
        i === index ? { ...column, visible: !column.visible } : column,
      ),
    );

  const onDrop = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    if (dragging !== null && dragging !== index) {
      onColumnsChange(moveColumn(columns, dragging, index));
    }
    setDragging(null);
  };

  const onHandleKey = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    onColumnsChange(
      moveColumn(columns, index, index + (event.key === "ArrowUp" ? -1 : 1)),
    );
  };

  return (
    <>
      <s-button
        icon="layout-columns-3"
        commandFor={popoverId}
        accessibilityLabel="Sort and columns"
        interestFor={`${popoverId}-tip`}
      />
      <s-tooltip id={`${popoverId}-tip`}>Sort and columns</s-tooltip>
      <s-popover
        id={popoverId}
        maxBlockSize="560px"
        onAfterHide={() => setSortOpen(false)}
      >
        <s-box padding="small-200" minInlineSize="280px">
          <s-stack direction="block" gap="small-300">
            <s-clickable
              borderRadius="base"
              paddingInline="small-200"
              paddingBlock="small-400"
              inlineSize="100%"
              onClick={() => setSortOpen((open) => !open)}
              accessibilityLabel={`Sort by ${SORT_LABEL[sort.key]}, ${directions[sort.direction]}`}
            >
              <s-grid
                gridTemplateColumns="auto 1fr auto auto"
                gap="small-200"
                alignItems="center"
              >
                <s-icon type="sort" />
                <s-text>Sort by</s-text>
                <s-text>{SORT_LABEL[sort.key]}</s-text>
                <s-icon type={sortOpen ? "chevron-up" : "select"} />
              </s-grid>
            </s-clickable>

            {sortOpen ? (
              <s-box paddingInlineStart="large">
                <s-stack direction="block" gap="none">
                  {PRODUCT_SORT_KEYS.map((key) => (
                    <SortChoice
                      key={key}
                      label={SORT_LABEL[key]}
                      selected={key === sort.key}
                      onSelect={() =>
                        onSortChange({ key, direction: defaultDirection(key) })
                      }
                    />
                  ))}
                  <s-divider />
                  {(["asc", "desc"] as const).map((direction) => (
                    <SortChoice
                      key={direction}
                      label={directions[direction]}
                      selected={direction === sort.direction}
                      onSelect={() => onSortChange({ ...sort, direction })}
                    />
                  ))}
                </s-stack>
              </s-box>
            ) : null}

            <s-box paddingInline="small-200">
              <s-grid
                gridTemplateColumns="auto 1fr auto"
                gap="small-200"
                alignItems="center"
              >
                <s-icon type="archive" />
                <s-text {...(hideArchivedDisabled ? { color: "subdued" } : {})}>
                  Hide archived
                </s-text>
                <s-switch
                  label="Hide archived"
                  labelAccessibilityVisibility="exclusive"
                  checked={hideArchived && !hideArchivedDisabled}
                  onChange={(event) =>
                    onHideArchivedChange(event.currentTarget.checked)
                  }
                  {...(hideArchivedDisabled ? { disabled: true } : {})}
                />
              </s-grid>
            </s-box>

            <s-divider />

            <s-box paddingInline="small-200">
              <s-text color="subdued">Columns</s-text>
            </s-box>

            <s-stack direction="block" gap="none">
              {columns.map((column, index) => {
                const label = COLUMN_LABEL[column.key];
                return (
                  <div
                    key={column.key}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      setDragging(index);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => onDrop(event, index)}
                    onDragEnd={() => setDragging(null)}
                    // `s-clickable` takes no key handler; the handle's keys
                    // bubble here.
                    onKeyDown={(event) => onHandleKey(event, index)}
                  >
                    <s-box
                      paddingInline="small-200"
                      paddingBlock="small-500"
                      borderRadius="base"
                      {...(dragging === index
                        ? { background: "subdued" as const }
                        : {})}
                    >
                      <s-grid
                        gridTemplateColumns="auto 1fr auto"
                        gap="small-200"
                        alignItems="center"
                      >
                        <s-clickable
                          accessibilityLabel={`Move ${label}. Use the up and down arrow keys.`}
                        >
                          <s-icon type="drag-handle" />
                        </s-clickable>
                        <s-text
                          {...(column.visible ? {} : { color: "subdued" })}
                        >
                          {label}
                        </s-text>
                        <s-button
                          variant="tertiary"
                          icon={column.visible ? "view" : "hide"}
                          accessibilityLabel={
                            column.visible ? `Hide ${label}` : `Show ${label}`
                          }
                          onClick={() => toggle(index)}
                        />
                      </s-grid>
                    </s-box>
                  </div>
                );
              })}
            </s-stack>
          </s-stack>
        </s-box>
      </s-popover>
    </>
  );
}

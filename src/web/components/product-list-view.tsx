import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
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
 * has them: a search box that suggests filters as you type, a chip per
 * filter in force that filters by "is any of", and one button
 * that opens sort, hide archived and the columns — each column shown or
 * hidden with its eye, and put in order by dragging its handle (or with the
 * arrow keys on the handle).
 *
 * Built from Polaris pieces (`s-clickable-chip`, `s-popover`, `s-clickable`,
 * `s-checkbox`, `s-switch`). Plain elements only where Polaris has nothing:
 * the `div` that carries native drag and drop, and the search suggestions'
 * list (see `ProductSearchBar`).
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

/**
 * The filters in force, one chip each that reopens its values, and a way to
 * clear them all. Filters are added from the search box's suggestions.
 */
export function ProductFilterChips({
  filters,
  options,
  onChange,
  onClearAll,
}: {
  filters: ProductFilters;
  options: ProductFilters;
  onChange: (facet: ProductFacet, values: string[]) => void;
  onClearAll: () => void;
}) {
  const active = PRODUCT_FACETS.filter((facet) => filters[facet].length > 0);
  if (active.length === 0) return null;
  return (
    <s-stack direction="inline" gap="small-300" alignItems="center">
      {active.map((facet) => (
        <FacetChip
          key={facet}
          facet={facet}
          options={options[facet]}
          selected={filters[facet]}
          onChange={(values) => onChange(facet, values)}
        />
      ))}
      <s-button variant="tertiary" onClick={onClearAll}>
        Clear all
      </s-button>
    </s-stack>
  );
}

/* -------------------------------------------------------------------------- */
/* Search and filter                                                          */
/* -------------------------------------------------------------------------- */

const FACET_PLURAL: Record<ProductFacet, string> = {
  vendor: "vendors",
  productType: "product types",
  category: "categories",
  tag: "tags",
};

/** How many matching values of each facet the search suggests. */
const VALUES_PER_FACET = 3;

type SearchItem =
  | { kind: "facet"; facet: ProductFacet }
  | { kind: "value"; facet: ProductFacet; value: string };

/**
 * The search box, which also filters, the way the admin's product index
 * does it. Typing searches products and, beneath the box, suggests the
 * filters whose name matches ("Vendor is…") and the values that match
 * ("Vendor is Aeryn"). Choosing a filter puts it in front of the box —
 * "Vendor is" — and the list becomes that filter's values with checkboxes,
 * narrowed by what is typed. Arrow keys move through the list, Enter picks
 * or ticks, Backspace in an empty box drops back to searching, Escape
 * closes.
 *
 * Polaris has no combobox and its popover takes focus from the field, so
 * the list is drawn here: Polaris boxes and rows inside one plain `div`
 * placed under the field. Its position and shadow are the only styling of
 * our own. The list keeps focus in the field by refusing mouse-down.
 */
export function ProductSearchBar({
  search,
  onSearchChange,
  filters,
  options,
  onFilterChange,
}: {
  search: string;
  onSearchChange: (text: string) => void;
  filters: ProductFilters;
  options: ProductFilters;
  /** `clearSearch`: drop the typed search in the same change. */
  onFilterChange: (
    facet: ProductFacet,
    values: string[],
    clearSearch: boolean,
  ) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLElementTagNameMap["s-search-field"]>(null);
  const [facet, setFacet] = useState<ProductFacet | null>(null);
  const [facetText, setFacetText] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [place, setPlace] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const text = (facet ? facetText : search).trim().toLowerCase();

  // In a filter: its values, the ticked ones that the snapshot no longer
  // has first so they can be unticked.
  const facetValues = facet
    ? [
        ...filters[facet].filter((v) => !options[facet].includes(v)),
        ...options[facet],
      ].filter((v) => v.toLowerCase().includes(text))
    : [];

  // Searching: the filters whose name matches, then matching values.
  const searchItems: SearchItem[] = facet
    ? []
    : [
        ...PRODUCT_FACETS.filter((f) =>
          FACET_LABEL[f].toLowerCase().includes(text),
        ).map((f): SearchItem => ({ kind: "facet", facet: f })),
        ...(text === ""
          ? []
          : PRODUCT_FACETS.flatMap((f) =>
              options[f]
                .filter((v) => v.toLowerCase().includes(text))
                .slice(0, VALUES_PER_FACET)
                .map((value): SearchItem => ({
                  kind: "value",
                  facet: f,
                  value,
                })),
            )),
      ];
  const count = facet ? facetValues.length : searchItems.length;
  const active = Math.min(highlight, Math.max(0, count - 1));

  const measure = () => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (rect) {
      setPlace({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  };
  useEffect(() => {
    if (!open) return;
    measure();
    // Focus can be lost without a blur this box hears, so a press anywhere
    // else closes the list as well.
    const outside = (event: PointerEvent) => {
      if (!event.composedPath().includes(wrapper.current as EventTarget)) {
        setOpen(false);
      }
    };
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open, facet]);

  const toggle = (f: ProductFacet, value: string, clearSearch = false) =>
    onFilterChange(
      f,
      filters[f].includes(value)
        ? filters[f].filter((v) => v !== value)
        : [...filters[f], value],
      clearSearch,
    );

  const enterFacet = (f: ProductFacet) => {
    // What was typed found the filter; it is not a search.
    onSearchChange("");
    setFacet(f);
    setFacetText("");
    setHighlight(0);
    setOpen(true);
    field.current?.focus();
  };
  const leaveFacet = () => {
    setFacet(null);
    setFacetText("");
    setHighlight(0);
  };

  const activate = (index: number) => {
    // A clicked row can take focus and then vanish as the list changes,
    // leaving focus nowhere; it goes back to the box either way.
    field.current?.focus();
    if (facet) {
      const value = facetValues[index];
      if (value !== undefined) toggle(facet, value);
      return;
    }
    const item = searchItems[index];
    if (!item) return;
    if (item.kind === "facet") {
      enterFacet(item.facet);
    } else {
      // The typed words were the way to the value, not a search.
      toggle(item.facet, item.value, true);
      setHighlight(0);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        setOpen(true);
        if (count === 0) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((active + step + count) % count);
        return;
      }
      case "Enter":
        if (open && count > 0) {
          event.preventDefault();
          activate(active);
        }
        return;
      case "Escape":
        event.preventDefault();
        if (facet && facetText === "") leaveFacet();
        else setOpen(false);
        return;
      case "Backspace":
        if (facet && facetText === "") {
          event.preventDefault();
          leaveFacet();
        }
        return;
    }
  };

  const enterHint = (
    <s-stack direction="inline" gap="small-500" alignItems="center">
      <s-icon type="enter" tone="neutral" size="small" />
      <s-text color="subdued">Enter</s-text>
    </s-stack>
  );

  const row = (index: number, content: ReactNode, onClick?: () => void) => {
    const isActive = index === active;
    const inner = (
      <s-grid
        gridTemplateColumns="1fr auto"
        gap="small-200"
        alignItems="center"
      >
        {content}
        {isActive ? enterHint : null}
      </s-grid>
    );
    return (
      <div key={index} onMouseEnter={() => setHighlight(index)}>
        {onClick ? (
          <s-clickable
            borderRadius="base"
            paddingInline="small-200"
            paddingBlock="small-400"
            inlineSize="100%"
            {...(isActive ? { background: "subdued" as const } : {})}
            onClick={onClick}
          >
            {inner}
          </s-clickable>
        ) : (
          <s-box
            borderRadius="base"
            paddingInline="small-200"
            paddingBlock="small-400"
            {...(isActive ? { background: "subdued" as const } : {})}
          >
            {inner}
          </s-box>
        )}
      </div>
    );
  };

  const facetIndexOffset = searchItems.filter((i) => i.kind === "facet").length;

  return (
    <div
      ref={wrapper}
      onKeyDown={onKeyDown}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!wrapper.current?.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <s-grid
        gridTemplateColumns={facet ? "auto 1fr" : "1fr"}
        gap="small-300"
        alignItems="center"
      >
        {facet ? (
          <s-clickable-chip
            removable
            color="strong"
            accessibilityLabel={`${FACET_LABEL[facet]} is. Remove to search instead.`}
            onRemove={() => {
              leaveFacet();
              field.current?.focus();
            }}
          >
            {`${FACET_LABEL[facet]} is`}
          </s-clickable-chip>
        ) : null}
        <s-search-field
          ref={field}
          label="Search and filter products"
          labelAccessibilityVisibility="exclusive"
          placeholder={
            facet
              ? `Search ${FACET_PLURAL[facet]}`
              : "Search or filter by vendor, product type, category or tag"
          }
          value={facet ? facetText : search}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setHighlight(0);
            setOpen(true);
            if (facet) setFacetText(value);
            else onSearchChange(value);
          }}
        />
      </s-grid>

      {open && place && count + (facet ? 1 : 0) > 0 ? (
        <div
          role="listbox"
          aria-label={facet ? FACET_LABEL[facet] : "Suggestions"}
          onMouseDown={(event) => event.preventDefault()}
          style={{
            position: "fixed",
            top: place.top,
            left: place.left,
            width: Math.min(360, place.width),
            zIndex: 30,
            borderRadius: 12,
            boxShadow:
              "0 4px 12px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.06)",
          }}
        >
          <s-box
            background="base"
            borderRadius="large"
            padding="small-300"
            maxBlockSize="360px"
            overflow="hidden"
          >
            <s-scroll-box maxBlockSize="340px">
              <s-stack direction="block" gap="none">
                {facet ? (
                  facetValues.length === 0 ? (
                    <s-box padding="small-200">
                      <s-text color="subdued">
                        {options[facet].length === 0
                          ? `No product has a ${FACET_LABEL[facet].toLowerCase()} yet.`
                          : "Nothing matches."}
                      </s-text>
                    </s-box>
                  ) : (
                    facetValues.map((value, index) =>
                      row(
                        index,
                        <s-checkbox
                          label={value}
                          checked={filters[facet].includes(value)}
                          onChange={() => toggle(facet, value)}
                        />,
                      ),
                    )
                  )
                ) : (
                  <>
                    {facetIndexOffset > 0 ? (
                      <s-box paddingInline="small-200" paddingBlock="small-500">
                        <s-text color="subdued">Filters</s-text>
                      </s-box>
                    ) : null}
                    {searchItems.map((item, index) =>
                      item.kind === "facet" ? (
                        row(
                          index,
                          <s-stack
                            direction="inline"
                            gap="small-200"
                            alignItems="center"
                          >
                            <s-icon type="filter" />
                            <s-text>{`${FACET_LABEL[item.facet]} is…`}</s-text>
                          </s-stack>,
                          () => activate(index),
                        )
                      ) : (
                        <Fragment key={`${item.facet}:${item.value}`}>
                          {index === facetIndexOffset ? (
                            <s-box
                              paddingInline="small-200"
                              paddingBlock="small-500"
                            >
                              <s-text color="subdued">Matching values</s-text>
                            </s-box>
                          ) : null}
                          {row(
                            index,
                            <s-stack
                              direction="inline"
                              gap="small-200"
                              alignItems="center"
                            >
                              <s-icon
                                type={
                                  filters[item.facet].includes(item.value)
                                    ? "check"
                                    : "search"
                                }
                              />
                              <s-text>
                                {`${FACET_LABEL[item.facet]} is `}
                                <s-text type="strong">{item.value}</s-text>
                              </s-text>
                            </s-stack>,
                            () => activate(index),
                          )}
                        </Fragment>
                      ),
                    )}
                  </>
                )}
              </s-stack>
            </s-scroll-box>
          </s-box>
        </div>
      ) : null}
    </div>
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
